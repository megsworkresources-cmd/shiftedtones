import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { getCurrentUser } from "./users";
import { getDrill } from "../lib/drills";

/** Save a completed microphone practice session and update best scores. */
export const saveSession = mutation({
  args: {
    drill: v.string(),
    scenario: v.optional(v.string()),
    durationMs: v.number(),
    calmScore: v.number(),
    energyScore: v.number(),
    clarityScore: v.number(),
    stabilityScore: v.number(),
    overallScore: v.number(),
    avgPitchHz: v.number(),
    pitchRangeHz: v.number(),
    avgVolume: v.number(),
    volumeVariability: v.number(),
    wordsPerMinute: v.number(),
    voicedRatio: v.number(),
    dominantTone: v.string(),
    transcript: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");

    if (!getDrill(args.drill)) throw new Error("Unknown practice drill");
    const scores = [
      args.calmScore,
      args.energyScore,
      args.clarityScore,
      args.stabilityScore,
      args.overallScore,
    ];
    if (scores.some((score) => score < 0 || score > 100)) {
      throw new Error("Practice scores must be between 0 and 100");
    }
    if (args.durationMs < 0 || args.durationMs > 10 * 60 * 1000) {
      throw new Error("Practice duration is outside the supported range");
    }
    if ((args.scenario?.length ?? 0) > 2000 || (args.transcript?.length ?? 0) > 10000) {
      throw new Error("Practice text exceeds the supported length");
    }

    const sessionId = await ctx.db.insert("practiceSessions", {
      userId: user._id,
      ...args,
    });

    // Upsert drill attempt stats
    const existing = await ctx.db
      .query("drillAttempts")
      .withIndex("by_user_drill", (q) =>
        q.eq("userId", user._id).eq("drill", args.drill),
      )
      .unique();

    const isPersonalBest = !existing || args.overallScore > existing.bestScore;
    if (existing) {
      await ctx.db.patch(existing._id, {
        bestScore: Math.max(existing.bestScore, args.overallScore),
        attemptCount: existing.attemptCount + 1,
      });
    } else {
      await ctx.db.insert("drillAttempts", {
        userId: user._id,
        drill: args.drill,
        bestScore: args.overallScore,
        attemptCount: 1,
      });
    }

    // Award personal-best XP inside the same trusted server mutation as the
    // saved take. Clients cannot call a generic "add XP" endpoint repeatedly.
    if (isPersonalBest) {
      const now = new Date();
      const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dayNumber = Math.floor(localMidnight.getTime() / 86_400_000);
      const dayDate = new Date(dayNumber * 86_400_000);
      const day = `${dayDate.getFullYear()}-${dayDate.getMonth()}-${dayDate.getDate()}`;
      const daily = await ctx.db
        .query("dailyLog")
        .withIndex("by_user_day", (q) => q.eq("userId", user._id).eq("day", day))
        .unique();
      if (daily) {
        await ctx.db.patch(daily._id, { xpEarned: daily.xpEarned + 25 });
      } else {
        await ctx.db.insert("dailyLog", {
          userId: user._id,
          day,
          completed: [],
          xpEarned: 25,
        });
      }
    }

    return sessionId;
  },
});

/** Recent practice sessions, newest first. */
export const listSessions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 10 }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("practiceSessions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);
  },
});

/** Best score + attempts per drill. */
export const drillStats = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("drillAttempts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

/** Aggregate practice summary for the dashboard. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) {
      return {
        totalSessions: 0,
        totalMinutes: 0,
        avgOverall: 0,
        bestOverall: 0,
        streakDays: 0,
      };
    }
    const sessions = await ctx.db
      .query("practiceSessions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        totalMinutes: 0,
        avgOverall: 0,
        bestOverall: 0,
        streakDays: 0,
      };
    }

    const totalSessions = sessions.length;
    const totalMs = sessions.reduce((acc, s) => acc + s.durationMs, 0);
    const avgOverall = Math.round(
      sessions.reduce((acc, s) => acc + s.overallScore, 0) / totalSessions,
    );
    const bestOverall = Math.max(...sessions.map((s) => s.overallScore));

    // Distinct practice days sorted ascending → streak counting back from most recent day
    const days = Array.from(
      new Set(
        sessions.map((s) => {
          const d = new Date(s._creationTime);
          return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        }),
      ),
    ).sort((a, b) => {
      const [ay, am, ad] = a.split("-").map(Number);
      const [by, bm, bd] = b.split("-").map(Number);
      return new Date(ay, am, ad).getTime() - new Date(by, bm, bd).getTime();
    });

    let streakDays = 0;
    const dayMs = 86_400_000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Walk backwards from today (or yesterday if today not practiced yet)
    let cursor = today.getTime();
    const latestDay = days[days.length - 1];
    const [ly, lm, ld] = latestDay.split("-").map(Number);
    const latest = new Date(ly, lm, ld).getTime();
    if (latest < today.getTime() - dayMs) {
      // latest practice is older than yesterday → no active streak
      streakDays = 0;
    } else {
      if (latest < today.getTime()) cursor = today.getTime() - dayMs;
      for (let i = days.length - 1; i >= 0; i--) {
        const [y, m, d] = days[i].split("-").map(Number);
        const dayTime = new Date(y, m, d).getTime();
        if (dayTime === cursor) {
          streakDays++;
          cursor -= dayMs;
        } else {
          break;
        }
      }
    }

    return {
      totalSessions,
      totalMinutes: Math.round(totalMs / 60_000),
      avgOverall,
      bestOverall,
      streakDays,
    };
  },
});

/** Coach plumbing: one take (ownership-checked), enriched with drill copy. */
export const getSessionForCoach = internalQuery({
  args: { sessionId: v.id("practiceSessions") },
  handler: async (ctx, { sessionId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const session = await ctx.db.get(sessionId);
    if (!session || session.userId !== user._id) return null;
    const drill = getDrill(session.drill);
    return {
      userId: session.userId,
      drill: session.drill,
      drillName: drill?.name ?? session.drill,
      focus: drill?.focus ?? "",
      durationMs: session.durationMs,
      dominantTone: session.dominantTone,
      overallScore: session.overallScore,
      calmScore: session.calmScore,
      energyScore: session.energyScore,
      clarityScore: session.clarityScore,
      stabilityScore: session.stabilityScore,
      avgPitchHz: session.avgPitchHz,
      pitchRangeHz: session.pitchRangeHz,
      wordsPerMinute: session.wordsPerMinute,
      voicedRatio: session.voicedRatio,
      volumeVariability: session.volumeVariability,
      transcript: session.transcript,
      scenario: session.scenario,
    };
  },
});

/** Best overall score on a drill, or undefined when never practiced. */
export const getDrillBest = internalQuery({
  args: { userId: v.id("users"), drill: v.string() },
  handler: async (ctx, { userId, drill }) => {
    const row = await ctx.db
      .query("drillAttempts")
      .withIndex("by_user_drill", (q) => q.eq("userId", userId).eq("drill", drill))
      .unique();
    return row?.bestScore;
  },
});

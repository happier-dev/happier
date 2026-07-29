import type { UsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';

/**
 * Settings-home usage BANNER model (design remediation).
 *
 * Composed entirely from the single view-model owner (`buildUsageAnalyticsViewModel`
 * at the widest `year` window) — no second data source. Streaks are recomputed at
 * DAY resolution from `activity.calendarDays` (the server series is monthly at the
 * year granularity, so its bucket-streak would count months, not days).
 */

const DAY_MS = 86_400_000;

export interface UsageBannerMostUsedRow {
    key: string;
    label: string;
    events: number;
}

export interface UsageBannerModel {
    hasData: boolean;
    /** Widest-window (year) total — the closest honest "lifetime" figure available. */
    lifetimeTokens: number;
    /** Largest single trend bucket (peak month at year granularity). */
    peakBucketTokens: number;
    sessions: number;
    currentStreakDays: number;
    longestStreakDays: number;
    modelsTried: number;
    activeDays: number;
    totalEvents: number;
    busiestWindowLabel: string | null;
    favoriteModelLabel: string | null;
    mostUsed: UsageBannerMostUsedRow[];
}

function utcMidnightMs(iso: string): number | null {
    const ms = Date.parse(`${iso}T00:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
}

function todayUtcMs(nowMs: number): number {
    const now = new Date(nowMs);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export interface UsageBannerStreaks {
    currentStreakDays: number;
    longestStreakDays: number;
}

/**
 * Longest and current consecutive-active-day streaks from the daily calendar.
 * "Current" is anchored to today (or yesterday, so a not-yet-active today does
 * not break a live streak).
 */
export function computeCalendarStreaks(
    calendarDays: readonly { date: string; eventCount: number }[],
    nowMs: number,
): UsageBannerStreaks {
    const activeMs = new Set<number>();
    for (const day of calendarDays) {
        if (day.eventCount > 0) {
            const ms = utcMidnightMs(day.date);
            if (ms !== null) activeMs.add(ms);
        }
    }
    if (activeMs.size === 0) {
        return { currentStreakDays: 0, longestStreakDays: 0 };
    }

    const sorted = [...activeMs].sort((a, b) => a - b);
    let longest = 1;
    let run = 1;
    for (let i = 1; i < sorted.length; i += 1) {
        run = sorted[i]! - sorted[i - 1]! === DAY_MS ? run + 1 : 1;
        if (run > longest) longest = run;
    }

    const today = todayUtcMs(nowMs);
    let anchor: number | null = null;
    if (activeMs.has(today)) anchor = today;
    else if (activeMs.has(today - DAY_MS)) anchor = today - DAY_MS;

    let current = 0;
    if (anchor !== null) {
        let cursor = anchor;
        while (activeMs.has(cursor)) {
            current += 1;
            cursor -= DAY_MS;
        }
    }

    return { currentStreakDays: current, longestStreakDays: longest };
}

export function buildUsageBannerModel(
    viewModel: UsageAnalyticsViewModel,
    nowMs: number,
): UsageBannerModel {
    const { hero, insights, activity, leaders, trend } = viewModel;
    const streaks = computeCalendarStreaks(activity.calendarDays, nowMs);
    const peakBucketTokens = trend.reduce((peak, point) => Math.max(peak, point.tokens), 0);

    const mostUsed: UsageBannerMostUsedRow[] = leaders.models
        .filter((row) => row.eventCount > 0)
        .slice(0, 4)
        .map((row) => ({ key: row.key, label: row.label, events: row.eventCount }));

    return {
        hasData: hero.totalTokens > 0 || hero.events > 0,
        lifetimeTokens: hero.totalTokens,
        peakBucketTokens,
        sessions: hero.sessions,
        currentStreakDays: streaks.currentStreakDays,
        longestStreakDays: Math.max(streaks.longestStreakDays, insights.longestStreakDays),
        modelsTried: insights.modelsTried,
        activeDays: insights.activeDays,
        totalEvents: hero.events,
        busiestWindowLabel: insights.busiestHour?.label ?? insights.busiestDay?.label ?? null,
        favoriteModelLabel: insights.favoriteModel?.label ?? null,
        mostUsed,
    };
}

import { SessionReminderPresetsV1Schema } from '@happier-dev/protocol/account/settings/sessionReminderPresetsV1';
import type { SessionReminderPresetRule, SessionReminderPresetV1 } from '@happier-dev/protocol';
export { SessionReminderPresetsV1Schema } from '@happier-dev/protocol/account/settings/sessionReminderPresetsV1';
export type { SessionReminderPresetRule, SessionReminderPresetV1 } from '@happier-dev/protocol';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;

function localDayOrdinal(date: Date): number {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MILLIS_PER_DAY);
}

function localWeekStartOrdinal(date: Date): number {
    return localDayOrdinal(date) - ((date.getDay() + 6) % 7);
}

function setLocalMinuteOfDay(date: Date, minuteOfDay: number): void {
    date.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
}

export function sessionReminderPresetRuleKey(rule: SessionReminderPresetRule): string {
    if (rule.kind === 'relative_day') return `${rule.kind}:${rule.daysAhead}:${rule.minuteOfDay}`;
    if (rule.kind === 'next_calendar_weekday') return `${rule.kind}:${rule.weekday}:${rule.weeksAhead ?? 1}:${rule.minuteOfDay}`;
    return `${rule.kind}:${rule.weekday}:${rule.minuteOfDay}`;
}

export function inferSessionReminderPresetRule(selectedMs: number, nowMs = Date.now()): SessionReminderPresetRule | null {
    if (!Number.isFinite(selectedMs) || !Number.isFinite(nowMs) || selectedMs <= nowMs) return null;
    const selected = new Date(selectedMs);
    const now = new Date(nowMs);
    const daysAhead = localDayOrdinal(selected) - localDayOrdinal(now);
    if (daysAhead < 0) return null;
    const minuteOfDay = selected.getHours() * 60 + selected.getMinutes();
    const weeksAhead = (localWeekStartOrdinal(selected) - localWeekStartOrdinal(now)) / 7;
    if (daysAhead === 1) return { kind: 'relative_day', daysAhead, minuteOfDay };
    if (weeksAhead === 0) return { kind: 'next_weekday', weekday: selected.getDay(), minuteOfDay };
    if (weeksAhead >= 1) return {
        kind: 'next_calendar_weekday',
        weekday: selected.getDay(),
        ...(weeksAhead > 1 ? { weeksAhead } : {}),
        minuteOfDay,
    };
    return { kind: 'relative_day', daysAhead, minuteOfDay };
}

export function resolveSessionReminderPresetRule(rule: SessionReminderPresetRule, nowMs = Date.now()): number {
    const now = new Date(nowMs);
    const resolved = new Date(nowMs);
    if (rule.kind === 'relative_day') {
        resolved.setDate(resolved.getDate() + rule.daysAhead);
        setLocalMinuteOfDay(resolved, rule.minuteOfDay);
        return resolved.getTime();
    }
    if (rule.kind === 'next_calendar_weekday') {
        resolved.setDate(resolved.getDate() - ((now.getDay() + 6) % 7) + (rule.weeksAhead ?? 1) * 7 + ((rule.weekday + 6) % 7));
        setLocalMinuteOfDay(resolved, rule.minuteOfDay);
        return resolved.getTime();
    }
    resolved.setDate(resolved.getDate() + ((rule.weekday - now.getDay() + 7) % 7));
    setLocalMinuteOfDay(resolved, rule.minuteOfDay);
    if (resolved.getTime() <= nowMs) {
        resolved.setDate(resolved.getDate() + 7);
        setLocalMinuteOfDay(resolved, rule.minuteOfDay);
    }
    return resolved.getTime();
}

export function upsertSessionReminderPreset(
    presets: readonly SessionReminderPresetV1[],
    nextPreset: SessionReminderPresetV1,
): SessionReminderPresetV1[] {
    const nextKey = sessionReminderPresetRuleKey(nextPreset.rule);
    const existingIndex = presets.findIndex((preset) => sessionReminderPresetRuleKey(preset.rule) === nextKey);
    if (existingIndex < 0) return [...presets, nextPreset];
    return presets.map((preset, index) => index === existingIndex ? nextPreset : preset);
}

/**
 * A preset-list change expressed as an intent, so the Account-settings writer can apply it to the
 * value that is current when the write happens instead of a snapshot captured before a modal and a
 * network round trip — otherwise a preset added or removed meanwhile is silently dropped.
 */
export type SessionReminderPresetIntent =
    | Readonly<{ kind: 'upsert'; preset: SessionReminderPresetV1 }>
    | Readonly<{ kind: 'replace'; presets: readonly SessionReminderPresetV1[]; expectedPresets: readonly SessionReminderPresetV1[] }>;

export class SessionReminderPresetConflictError extends Error {
    constructor() {
        super('Reminder presets changed while editing');
        this.name = 'SessionReminderPresetConflictError';
    }
}

export function applySessionReminderPresetIntent(
    presets: readonly SessionReminderPresetV1[],
    intent: SessionReminderPresetIntent,
): SessionReminderPresetV1[] {
    if (intent.kind === 'replace' && (presets.length !== intent.expectedPresets.length
        || presets.some((preset, index) => {
            const expected = intent.expectedPresets[index];
            return !expected || preset.label !== expected.label
                || sessionReminderPresetRuleKey(preset.rule) !== sessionReminderPresetRuleKey(expected.rule);
        }))) {
        throw new SessionReminderPresetConflictError();
    }
    return intent.kind === 'upsert'
        ? upsertSessionReminderPreset(presets, intent.preset)
        : [...intent.presets];
}

export function applySessionReminderPresetIntentToAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    intent: SessionReminderPresetIntent,
): Record<string, unknown> {
    const current = SessionReminderPresetsV1Schema.safeParse(raw.sessionReminderPresetsV1);
    return {
        ...raw,
        sessionReminderPresetsV1: applySessionReminderPresetIntent(current.success ? current.data : [], intent),
    };
}

export function formatSessionReminderPresetRuleLabel(
    rule: SessionReminderPresetRule,
    nowMs = Date.now(),
    locales?: Intl.LocalesArgument,
): string {
    const resolved = new Date(resolveSessionReminderPresetRule(rule, nowMs));
    const time = new Intl.DateTimeFormat(locales, { hour: 'numeric', minute: '2-digit' }).format(resolved);
    if (rule.kind === 'relative_day' && rule.daysAhead === 1) {
        const relative = new Intl.RelativeTimeFormat(locales, { numeric: 'auto' }).format(1, 'day');
        return `${relative.charAt(0).toLocaleUpperCase() + relative.slice(1)} · ${time}`;
    }
    if (rule.kind === 'relative_day') {
        const relative = new Intl.RelativeTimeFormat(locales, { numeric: 'always' }).format(rule.daysAhead, 'day');
        return `${relative.charAt(0).toLocaleUpperCase() + relative.slice(1)} · ${time}`;
    }
    const weekday = new Intl.DateTimeFormat(locales, { weekday: 'long' }).format(resolved);
    if (rule.kind === 'next_weekday') return `${weekday} · ${time}`;
    const weeksAhead = rule.weeksAhead ?? 1;
    const locale = new Intl.DateTimeFormat(locales).resolvedOptions().locale;
    if (locale.toLowerCase().startsWith('en')) {
        return weeksAhead === 1
            ? `Next ${weekday} · ${time}`
            : `${weekday} ${new Intl.RelativeTimeFormat(locales, { numeric: 'always' }).format(weeksAhead, 'week')} · ${time}`;
    }
    const nextWeek = new Intl.RelativeTimeFormat(locales, { numeric: weeksAhead === 1 ? 'auto' : 'always' }).format(weeksAhead, 'week');
    return `${nextWeek.charAt(0).toLocaleUpperCase() + nextWeek.slice(1)} · ${weekday} · ${time}`;
}

import type { SessionReminderPresetRule } from '@happier-dev/protocol/account/settings/sessionReminderPresetsV1';
export { SessionReminderPresetsV1Schema } from '@happier-dev/protocol/account/settings/sessionReminderPresetsV1';
export type { SessionReminderPresetRule, SessionReminderPresetV1 } from '@happier-dev/protocol/account/settings/sessionReminderPresetsV1';
export {
    sessionReminderPresetRuleKey,
    upsertSessionReminderPreset,
    applySessionReminderPresetIntent,
    SessionReminderPresetConflictError,
    type SessionReminderPresetIntent,
} from '@happier-dev/protocol/account/settings/sessionReminderPresetsV1';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;

function formatRelativeOrAbsolute(locales: Intl.LocalesArgument | undefined, value: number, unit: Intl.RelativeTimeFormatUnit, date: Date): string {
    try {
        return new Intl.RelativeTimeFormat(locales, { numeric: value === 1 ? 'auto' : 'always' }).format(value, unit);
    } catch {
        return new Intl.DateTimeFormat(locales, { dateStyle: 'medium' }).format(date);
    }
}

function localDayOrdinal(date: Date): number {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MILLIS_PER_DAY);
}

function localWeekStartOrdinal(date: Date): number {
    return localDayOrdinal(date) - ((date.getDay() + 6) % 7);
}

function setLocalMinuteOfDay(date: Date, minuteOfDay: number): void {
    date.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
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

export function formatSessionReminderPresetRuleLabel(
    rule: SessionReminderPresetRule,
    nowMs = Date.now(),
    locales?: Intl.LocalesArgument,
): string {
    const resolved = new Date(resolveSessionReminderPresetRule(rule, nowMs));
    const time = new Intl.DateTimeFormat(locales, { hour: 'numeric', minute: '2-digit' }).format(resolved);
    if (rule.kind === 'relative_day' && rule.daysAhead === 1) {
        const relative = formatRelativeOrAbsolute(locales, 1, 'day', resolved);
        return `${relative.charAt(0).toLocaleUpperCase() + relative.slice(1)} · ${time}`;
    }
    if (rule.kind === 'relative_day') {
        const relative = formatRelativeOrAbsolute(locales, rule.daysAhead, 'day', resolved);
        return `${relative.charAt(0).toLocaleUpperCase() + relative.slice(1)} · ${time}`;
    }
    const weekday = new Intl.DateTimeFormat(locales, { weekday: 'long' }).format(resolved);
    if (rule.kind === 'next_weekday') return `${weekday} · ${time}`;
    const weeksAhead = rule.weeksAhead ?? 1;
    const locale = new Intl.DateTimeFormat(locales).resolvedOptions().locale;
    if (locale.toLowerCase().startsWith('en')) {
        return weeksAhead === 1
            ? `Next ${weekday} · ${time}`
            : `${weekday} ${formatRelativeOrAbsolute(locales, weeksAhead, 'week', resolved)} · ${time}`;
    }
    const nextWeek = formatRelativeOrAbsolute(locales, weeksAhead, 'week', resolved);
    return `${nextWeek.charAt(0).toLocaleUpperCase() + nextWeek.slice(1)} · ${weekday} · ${time}`;
}

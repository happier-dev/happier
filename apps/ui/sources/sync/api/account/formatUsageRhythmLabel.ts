import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';

export function formatUsageWeekdayLabel(weekday: number): string {
    return formatUsageCalendarDate(Date.UTC(2024, 0, 7 + weekday), 0, { weekday: 'short' });
}

export function formatUsageHourLabel(hour: number): string {
    return formatUsageCalendarDate(Date.UTC(2024, 0, 1, hour), 0, { hour: 'numeric' });
}

export function formatUsageWeekdayHourLabel(weekday: number, hour: number): string {
    return `${formatUsageWeekdayLabel(weekday)} · ${formatUsageHourLabel(hour)}`;
}

export function formatUsageWeekdayLabel(weekday: number): string {
    const base = new Date(Date.UTC(2024, 0, 7 + weekday));
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(base);
}

export function formatUsageHourLabel(hour: number): string {
    const base = new Date(Date.UTC(2024, 0, 1, hour));
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(base);
}

export function formatUsageWeekdayHourLabel(weekday: number, hour: number): string {
    return `${formatUsageWeekdayLabel(weekday)} · ${formatUsageHourLabel(hour)}`;
}

import type { SettingsAnalyticsPropertyValue } from './types';

export function diffAnalyticsProperties(
    previous: Record<string, SettingsAnalyticsPropertyValue> | null,
    next: Record<string, SettingsAnalyticsPropertyValue>,
): Record<string, SettingsAnalyticsPropertyValue> | null {
    if (!previous) return next;

    const changedEntries = Object.entries(next).filter(([key, value]) => previous[key] !== value);
    if (changedEntries.length === 0) return null;
    return Object.fromEntries(changedEntries);
}

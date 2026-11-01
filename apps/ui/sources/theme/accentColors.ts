/** Named accents shared by theme consumers and persisted appearance choices. */
export const ACCENT_COLOR_KEYS = ['blue', 'green', 'orange', 'yellow', 'red', 'indigo', 'purple'] as const;
export type AccentColorKey = typeof ACCENT_COLOR_KEYS[number];

export function parseAccentColorKey(value: unknown): AccentColorKey | null {
    if (typeof value !== 'string') return null;
    const key = value.trim().toLowerCase();
    return ACCENT_COLOR_KEYS.find((candidate) => candidate === key) ?? null;
}

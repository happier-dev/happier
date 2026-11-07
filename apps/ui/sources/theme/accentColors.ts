/** Canonical named accents shared by theme consumers and persisted appearance choices. */
import { SESSION_APPEARANCE_ACCENT_COLOR_KEYS } from '@happier-dev/protocol/sessions/organization/appearances';
export const ACCENT_COLOR_KEYS = SESSION_APPEARANCE_ACCENT_COLOR_KEYS;
export type AccentColorKey = typeof ACCENT_COLOR_KEYS[number];

export function parseAccentColorKey(value: unknown): AccentColorKey | null {
    if (typeof value !== 'string') return null;
    const key = value.trim().toLowerCase();
    return ACCENT_COLOR_KEYS.find(candidate => candidate === key) ?? null;
}

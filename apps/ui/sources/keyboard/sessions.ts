/**
 * Keyboard-specific session shortcut policy.
 *
 * Session-navigation order (visible order, MRU order, direction stepping) is owned by
 * `@/sync/domains/session/navigation/sessionNavigationOrder`; the keyboard layer only
 * decides which shortcuts are available.
 */

export type SessionMruShortcutPlatform = 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'native';
export type SessionMruShortcutWebHost = 'browser' | 'desktop' | null;

export function resolveDefaultSessionMruShortcutAvailability(params: Readonly<{
    platform: SessionMruShortcutPlatform;
    webHost: SessionMruShortcutWebHost;
    optIn: boolean;
}>): boolean {
    if (params.platform !== 'web') return true;
    if (params.webHost !== 'browser') return true;
    return params.optIn === true;
}

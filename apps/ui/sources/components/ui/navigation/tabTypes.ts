/**
 * Every tab the phone's main tab bar can show; `resolveTabBarTabs` decides which ones it does (owner Q4,
 * 2026-10-30: Sessions, Projects, Inbox, Workflows — Settings opens from the avatar).
 */
export const TAB_TYPES = ['sessions', 'projects', 'inbox', 'workflows'] as const;
export type TabType = typeof TAB_TYPES[number];

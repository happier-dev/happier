export type SettingsAnalyticsPropertyValue = boolean | string | number | null;

export type SettingsAnalyticsSnapshot = Readonly<{
    properties: Record<string, SettingsAnalyticsPropertyValue>;
}>;

export type SettingsAnalyticsSource =
    | 'ui'
    | 'migration'
    | 'bootstrap'
    | 'sync_pull'
    | 'system'
    | 'test'
    | 'unknown';

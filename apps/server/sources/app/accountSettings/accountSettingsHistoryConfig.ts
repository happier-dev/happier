export const ACCOUNT_SETTINGS_HISTORY_LIMIT_ENV = "HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT";
export const DEFAULT_ACCOUNT_SETTINGS_HISTORY_LIMIT = 25;
export const MAX_ACCOUNT_SETTINGS_HISTORY_LIMIT = 250;

export function resolveAccountSettingsHistoryLimitFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = env[ACCOUNT_SETTINGS_HISTORY_LIMIT_ENV];
    if (typeof raw !== "string") return DEFAULT_ACCOUNT_SETTINGS_HISTORY_LIMIT;

    const trimmed = raw.trim();
    if (!trimmed) return DEFAULT_ACCOUNT_SETTINGS_HISTORY_LIMIT;

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ACCOUNT_SETTINGS_HISTORY_LIMIT;
    if (parsed < 0) return DEFAULT_ACCOUNT_SETTINGS_HISTORY_LIMIT;
    return Math.min(parsed, MAX_ACCOUNT_SETTINGS_HISTORY_LIMIT);
}

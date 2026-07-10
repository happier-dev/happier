export const CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID = 'reasoning_effort';
export const CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID = 'service_tier';
export const CODEX_APP_SERVER_LEGACY_SPEED_CONFIG_OPTION_ID = 'speed';

export function normalizeCodexAppServerConfigOptionId(id: unknown): string | null {
    if (typeof id !== 'string') return null;
    const normalized = id.trim();
    if (!normalized) return null;
    if (normalized === CODEX_APP_SERVER_LEGACY_SPEED_CONFIG_OPTION_ID) {
        return CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID;
    }
    return normalized;
}

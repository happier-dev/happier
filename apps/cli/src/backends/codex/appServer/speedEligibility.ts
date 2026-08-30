const CODEX_FAST_SERVICE_TIER_ID = 'priority';
const CODEX_LEGACY_FAST_SERVICE_TIER_ID = 'fast';

type CodexAppServerModelRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function hasFastServiceTier(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return value.some((entry) => {
        const record = asRecord(entry);
        const id = typeof record?.id === 'string' ? record.id.trim().toLowerCase() : null;
        return id === CODEX_FAST_SERVICE_TIER_ID || id === CODEX_LEGACY_FAST_SERVICE_TIER_ID;
    });
}

function hasLegacyFastSpeedTier(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return value.some((entry) => (
        typeof entry === 'string'
        && entry.trim().toLowerCase() === CODEX_LEGACY_FAST_SERVICE_TIER_ID
    ));
}

export function isCodexAppServerFastModelEligible(modelRecord?: CodexAppServerModelRecord | null): boolean {
    const serviceTiers = modelRecord?.serviceTiers ?? modelRecord?.service_tiers;
    const additionalSpeedTiers = modelRecord?.additionalSpeedTiers ?? modelRecord?.additional_speed_tiers;
    return hasFastServiceTier(serviceTiers) || hasLegacyFastSpeedTier(additionalSpeedTiers);
}

export function isCodexAppServerFastServiceTier(value: string | null | undefined): boolean {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === CODEX_FAST_SERVICE_TIER_ID || normalized === CODEX_LEGACY_FAST_SERVICE_TIER_ID;
}

export function isCodexAppServerSpeedEligible(params: Readonly<{
    authMethod?: string | null;
    modelRecord?: CodexAppServerModelRecord | null;
}>): boolean {
    if (!isCodexAppServerFastModelEligible(params.modelRecord)) return false;
    return params.authMethod === 'oauth_cli' || params.authMethod === 'credentials_file';
}

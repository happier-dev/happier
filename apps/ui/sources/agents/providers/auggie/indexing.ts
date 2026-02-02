export const HAPPIER_AUGGIE_ALLOW_INDEXING_ENV_VAR = 'HAPPIER_AUGGIE_ALLOW_INDEXING' as const;

export const AUGGIE_ALLOW_INDEXING_METADATA_KEY = 'auggieAllowIndexing' as const;

export const AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING = 'allowIndexing' as const;

export function applyAuggieAllowIndexingEnv(
    env: Record<string, string> | undefined,
    allowIndexing: boolean,
): Record<string, string> | undefined {
    if (allowIndexing !== true) return env;
    return { ...(env ?? {}), [HAPPIER_AUGGIE_ALLOW_INDEXING_ENV_VAR]: '1' };
}

export function readAuggieAllowIndexingFromMetadata(metadata: unknown): boolean | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const v = (metadata as any)[AUGGIE_ALLOW_INDEXING_METADATA_KEY];
    return typeof v === 'boolean' ? v : null;
}

export type CodexBackendModeOverride = 'mcp' | 'acp' | null;

export function normalizeCodexBackendModeOverride(value: unknown): CodexBackendModeOverride {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    // Treat `appServer` as the default, not an override; only shard on explicit fallbacks.
    return trimmed === 'mcp' || trimmed === 'acp' ? trimmed : null;
}

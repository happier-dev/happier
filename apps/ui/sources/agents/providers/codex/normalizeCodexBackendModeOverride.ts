import { normalizeCodexBackendMode } from '@happier-dev/protocol';

export type CodexBackendModeOverride = 'mcp' | 'acp' | null;

export function normalizeCodexBackendModeOverride(value: unknown): CodexBackendModeOverride {
    // Treat `appServer` as the default, not an override; only shard on explicit fallbacks.
    const normalized = normalizeCodexBackendMode(value);
    return normalized === 'mcp' || normalized === 'acp' ? normalized : null;
}

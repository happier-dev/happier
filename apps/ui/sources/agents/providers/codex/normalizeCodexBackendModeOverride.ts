import { normalizeCodexBackendMode } from '@happier-dev/protocol';

export type CodexBackendModeOverride = 'acp' | null;

export function normalizeCodexBackendModeOverride(value: unknown): CodexBackendModeOverride {
    // Treat `appServer` as the default, not an override; only shard on explicit fallbacks.
    const normalized = normalizeCodexBackendMode(value);
    return normalized === 'acp' ? normalized : null;
}

import { isAgentId } from '@/agents/catalog/catalog';
import { buildBackendTargetKey, parseBackendTargetKey } from '@happier-dev/protocol';

export type BackendNewSessionOptionStateByTargetKey = Record<string, Record<string, unknown>>;

type LegacyBackendNewSessionOptionStateSource = Readonly<{
    backendNewSessionOptionStateByTargetKey?: BackendNewSessionOptionStateByTargetKey | null;
    agentNewSessionOptionStateByAgentId?: BackendNewSessionOptionStateByTargetKey | null;
}>;

function normalizeBackendNewSessionOptionStateKey(rawKey: string): string {
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) {
        return '';
    }

    try {
        return buildBackendTargetKey(parseBackendTargetKey(trimmedKey));
    } catch {
        if (isAgentId(trimmedKey)) {
            return buildBackendTargetKey({ kind: 'builtInAgent', agentId: trimmedKey });
        }
        return trimmedKey;
    }
}

export function normalizeBackendNewSessionOptionStateByTargetKey(
    input: BackendNewSessionOptionStateByTargetKey | null | undefined,
): BackendNewSessionOptionStateByTargetKey | null {
    if (!input || typeof input !== 'object') {
        return null;
    }

    const normalized: BackendNewSessionOptionStateByTargetKey = {};
    for (const [rawKey, rawValue] of Object.entries(input)) {
        const normalizedKey = normalizeBackendNewSessionOptionStateKey(rawKey);
        if (!normalizedKey || !rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
            continue;
        }
        normalized[normalizedKey] = { ...rawValue };
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

export function readBackendNewSessionOptionStateByTargetKey(
    source: LegacyBackendNewSessionOptionStateSource | null | undefined,
): BackendNewSessionOptionStateByTargetKey | null {
    if (!source) {
        return null;
    }

    return normalizeBackendNewSessionOptionStateByTargetKey(
        source.backendNewSessionOptionStateByTargetKey ?? source.agentNewSessionOptionStateByAgentId,
    );
}

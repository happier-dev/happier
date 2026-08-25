import { readBackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

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
        return resolveBackendTargetKeyV2(readBackendTargetRefV2(trimmedKey as BackendTargetRefV2Input));
    } catch {
        const backendId = trimmedKey;
        try {
            return resolveBackendTargetKeyV2({ kind: 'backend', backendId } satisfies BackendTargetRefV2Input);
        } catch {
            return trimmedKey;
        }
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

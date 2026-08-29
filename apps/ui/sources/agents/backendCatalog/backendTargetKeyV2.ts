import {
    BackendTargetKeyV2Schema,
    PersistedBackendTargetRefV2Schema,
    buildBackendTargetKeyV2,
    parseBackendTargetKeyV2,
    readBackendTargetRefV2,
    type BackendTargetKeyV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';

function formatCanonicalBackendTargetKeyV2(target: PersistedBackendTargetRefV2): BackendTargetKeyV2 {
    // One bundled Agent carries exactly one canonical binding key: the qualified
    // contribution identity. The retired `backend:<bundledId>` spelling must
    // rekey onto it so persisted selections join current targets.
    const bundledIdentity = target.kind === 'backend' && !target.configuredBackendId
        ? BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[target.backendId as keyof typeof BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES] ?? null
        : null;
    if (bundledIdentity) {
        return buildBackendTargetKeyV2({ kind: 'agent', identity: bundledIdentity });
    }
    return buildBackendTargetKeyV2(target);
}

export function formatBackendTargetKeyV2(target: PersistedBackendTargetRefV2): BackendTargetKeyV2 {
    return formatCanonicalBackendTargetKeyV2(target);
}

export function resolveBackendTargetKeyV2(input: BackendTargetRefV2Input): BackendTargetKeyV2 {
    const canonicalTarget = PersistedBackendTargetRefV2Schema.safeParse(input);
    if (canonicalTarget.success) return formatCanonicalBackendTargetKeyV2(canonicalTarget.data);
    const canonicalKey = BackendTargetKeyV2Schema.safeParse(input);
    if (canonicalKey.success) {
        if (typeof input === 'string' && input.startsWith('backend:')) {
            try {
                return formatCanonicalBackendTargetKeyV2(parseBackendTargetKeyV2(input));
            } catch {
                return canonicalKey.data;
            }
        }
        return canonicalKey.data;
    }
    return formatCanonicalBackendTargetKeyV2(readBackendTargetRefV2(input));
}

/**
 * Compares two target keys by their canonical target identity rather than by
 * raw spelling, so persisted retired keys match the canonical Agent targets
 * that current writers emit.
 */
export function backendTargetKeysMatch(a: BackendTargetRefV2Input, b: BackendTargetRefV2Input): boolean {
    try {
        return resolveBackendTargetKeyV2(a) === resolveBackendTargetKeyV2(b);
    } catch {
        return false;
    }
}

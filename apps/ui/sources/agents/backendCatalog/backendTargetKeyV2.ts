import { BackendTargetKeyV2Schema, PersistedBackendTargetRefV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetKeyV2, type BackendTargetRefV2Input, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

function resolveAgentIdentityForBackendId(backendId: string): PluginContributionIdentityV1 | null {
    // A bundled Agent's single canonical key comes from the protocol key owner
    // (`buildBackendTargetKeyV2`). An installed Agent's host routing id *is* its qualified contribution key,
    // so `backend:<pluginId>/<localId>` names the same Agent as the canonical
    // `agent:` target. Without this, a Voice selection, remembered engine, or
    // persisted run target spelled in backend vocabulary never joins the
    // qualified target the rest of the app writes. Bundled ids carry no `/`, so
    // this branch only reaches installed Agents.
    return parseQualifiedPluginContributionKey(backendId);
}

function formatCanonicalBackendTargetKeyV2(target: PersistedBackendTargetRefV2): BackendTargetKeyV2 {
    const agentIdentity = target.kind === 'backend' && !target.configuredBackendId
        ? resolveAgentIdentityForBackendId(target.backendId)
        : null;
    if (agentIdentity) {
        return buildBackendTargetKeyV2({ kind: 'agent', identity: agentIdentity });
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

import {
    BackendTargetKeyV2Schema,
    PersistedBackendTargetRefV2Schema,
    PluginContributionIdentityV1Schema,
    parseBackendTargetKeyV2,
    readBackendTargetRefV2,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';
import { isLegacyCompatAgentType } from './legacyCompatAgents';
import { resolveBackendTargetKeyV2 } from './backendTargetKeyV2';

export type SerializedBackendTargetRouteParams = Partial<Readonly<{
    agentType: string;
    backendTarget: string;
    backendTargetKey: string;
}>>;

function stripBackendTargetSourceKind(target: PersistedBackendTargetRefV2): PersistedBackendTargetRefV2 {
    if (target.kind === 'agent') return target;
    // `sourceKind` is legacy split-brain vocabulary (built-in vs plugin vs configured).
    // Route params must not carry it; `configuredBackendId` is the only needed carrier.
    if (!('sourceKind' in target)) {
        return target;
    }

    const { sourceKind: _ignored, ...rest } = target as BackendTargetRefV2 & {
        sourceKind?: unknown;
    };
    return rest;
}

function parsePersistedTarget(value: unknown): PersistedBackendTargetRefV2 | null {
    const canonical = PersistedBackendTargetRefV2Schema.safeParse(value);
    if (canonical.success) return stripBackendTargetSourceKind(canonical.data);
    try {
        return stripBackendTargetSourceKind(readBackendTargetRefV2(value as BackendTargetRefV2Input));
    } catch {
        if (typeof value !== 'string') {
            return null;
        }

        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        try {
            return parsePersistedTarget(JSON.parse(trimmed));
        } catch {
            return null;
        }
    }
}

function parseBackendTargetKeySafe(value: unknown): PersistedBackendTargetRefV2 | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    const canonicalKey = BackendTargetKeyV2Schema.safeParse(trimmed);
    if (canonicalKey.success && canonicalKey.data.startsWith('agent:')) {
        const qualifiedIdentity = canonicalKey.data.slice('agent:'.length);
        const separatorIndex = qualifiedIdentity.indexOf('/');
        const identity = PluginContributionIdentityV1Schema.safeParse({
            pluginId: qualifiedIdentity.slice(0, separatorIndex),
            localId: qualifiedIdentity.slice(separatorIndex + 1),
        });
        return identity.success ? { kind: 'agent', identity: identity.data } : null;
    }
    try {
        return stripBackendTargetSourceKind(parseBackendTargetKeyV2(trimmed));
    } catch {
        try {
            return stripBackendTargetSourceKind(readBackendTargetRefV2(trimmed as BackendTargetRefV2Input));
        } catch {
            return null;
        }
    }
}

function resolveBackendTargetV2FromRouteParams(params: Readonly<{
    backendTarget?: unknown;
    backendTargetKey?: unknown;
    agentType?: unknown;
}>): PersistedBackendTargetRefV2 | null {
    const parsedTarget = parsePersistedTarget(params.backendTarget);
    if (parsedTarget) {
        return parsedTarget;
    }

    const parsedTargetKey = parseBackendTargetKeySafe(params.backendTargetKey);
    if (parsedTargetKey) {
        return parsedTargetKey;
    }

    if (typeof params.agentType === 'string') {
        const normalizedAgentType = params.agentType.trim();
        if (!normalizedAgentType || isLegacyCompatAgentType(normalizedAgentType) || !isBundledAgentId(normalizedAgentType)) {
            return null;
        }

        return {
            kind: 'agent',
            identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[normalizedAgentType],
        };
    }

    return null;
}

export function resolveBackendTargetFromRouteParams(params: Readonly<{
    backendTarget?: unknown;
    backendTargetKey?: unknown;
    agentType?: unknown;
}>): PersistedBackendTargetRefV2 | null {
    return resolveBackendTargetV2FromRouteParams(params);
}

export function resolveRouteCloseoutFallbackTarget(params: Readonly<{
    backendTarget?: unknown;
    backendTargetKey?: unknown;
    agentType?: unknown;
    preferredBackendTarget?: PersistedBackendTargetRefV2 | null;
}>): PersistedBackendTargetRefV2 | null {
    return resolveBackendTargetV2FromRouteParams(params)
        ?? params.preferredBackendTarget
        ?? null;
}

export function buildBackendTargetRouteParams(params: Readonly<{
    backendTarget?: unknown;
    backendTargetKey?: unknown;
    agentType?: unknown;
    fallbackTarget: PersistedBackendTargetRefV2 | null;
}>): SerializedBackendTargetRouteParams {
    const resolvedTargetV2 = params.fallbackTarget ?? resolveBackendTargetV2FromRouteParams(params);
    const routeParams: Partial<{
        agentType: string;
        backendTarget: string;
        backendTargetKey: string;
    }> = {};

    const sanitizedTarget = resolvedTargetV2 ? stripBackendTargetSourceKind(resolvedTargetV2) : null;

    if (sanitizedTarget?.kind === 'backend' && isBundledAgentId(sanitizedTarget.backendId) && !isLegacyCompatAgentType(sanitizedTarget.backendId)) {
        routeParams.agentType = sanitizedTarget.backendId;
    } else if (!resolvedTargetV2 && isBundledAgentId(params.agentType) && !isLegacyCompatAgentType(params.agentType)) {
        routeParams.agentType = params.agentType;
    }

    if (sanitizedTarget) {
        routeParams.backendTarget = JSON.stringify(sanitizedTarget);
        routeParams.backendTargetKey = resolveBackendTargetKeyV2(sanitizedTarget);
    } else {
        const serializedTarget = parsePersistedTarget(params.backendTarget);
        if (serializedTarget) {
            routeParams.backendTarget = JSON.stringify(serializedTarget);
            routeParams.backendTargetKey = resolveBackendTargetKeyV2(serializedTarget);
        } else {
            const parsedTargetKey = parseBackendTargetKeySafe(params.backendTargetKey);
            if (parsedTargetKey) {
                routeParams.backendTarget = JSON.stringify(parsedTargetKey);
                routeParams.backendTargetKey = resolveBackendTargetKeyV2(parsedTargetKey);
            }
        }
    }

    return routeParams;
}

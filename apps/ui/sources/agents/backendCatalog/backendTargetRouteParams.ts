import {
    buildBackendTargetKeyV2,
    convertBackendTargetRefV2ToV1,
    parseBackendTargetKeyV2,
    readBackendTargetRefV2,
    type BackendTargetRefV1,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';

import { isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolveBuiltInAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

export type SerializedBackendTargetRouteParams = Partial<Readonly<{
    agentType: AgentId;
    backendTarget: string;
    backendTargetKey: string;
}>>;

function parseSerializedBackendTarget(value: unknown): BackendTargetRefV2 | null {
    try {
        return readBackendTargetRefV2(value as never);
    } catch {
        if (typeof value !== 'string') {
            return null;
        }

        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        try {
            const parsed = JSON.parse(trimmed);
            return readBackendTargetRefV2(parsed as never);
        } catch {
            return null;
        }
    }
}

function parseBackendTargetKeySafe(value: unknown): BackendTargetRefV2 | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return parseBackendTargetKeyV2(trimmed);
    } catch {
        try {
            return readBackendTargetRefV2(trimmed as never);
        } catch {
            return null;
        }
    }
}

function parseSerializedBackendTargetCompat(value: unknown): BackendTargetRefV1 | null {
    const parsedTarget = parseSerializedBackendTarget(value);
    return parsedTarget ? convertBackendTargetRefV2ToV1(parsedTarget) : null;
}

function parseBackendTargetKeyCompat(value: unknown): BackendTargetRefV1 | null {
    const parsedTarget = parseBackendTargetKeySafe(value);
    return parsedTarget ? convertBackendTargetRefV2ToV1(parsedTarget) : null;
}

export function resolveBackendTargetFromRouteParams(params: Readonly<{
    backendTarget?: unknown;
    backendTargetKey?: unknown;
    agentType?: unknown;
}>): BackendTargetRefV1 | null {
    const parsedTarget = parseSerializedBackendTargetCompat(params.backendTarget);
    if (parsedTarget) {
        return parsedTarget;
    }

    const parsedTargetKey = parseBackendTargetKeyCompat(params.backendTargetKey);
    if (parsedTargetKey) {
        return parsedTargetKey;
    }

    if (isAgentId(params.agentType)) {
        return {
            kind: 'builtInAgent',
            agentId: params.agentType,
        };
    }

    return null;
}

export function resolveRouteCloseoutFallbackTarget(params: Readonly<{
    backendTarget?: unknown;
    backendTargetKey?: unknown;
    agentType?: unknown;
    preferredBackendTarget?: BackendTargetRefV1 | null;
}>): BackendTargetRefV1 | null {
    const routeTarget = resolveBackendTargetFromRouteParams(params);
    if (routeTarget?.kind === 'configuredAcpBackend') {
        return routeTarget;
    }

    if (routeTarget && !(routeTarget.kind === 'builtInAgent' && routeTarget.agentId === 'customAcp')) {
        return routeTarget;
    }

    if (routeTarget?.kind === 'builtInAgent' && routeTarget.agentId === 'customAcp') {
        return params.preferredBackendTarget ?? routeTarget;
    }

    return routeTarget;
}

export function buildBackendTargetRouteParams(params: Readonly<{
    backendTarget?: unknown;
    backendTargetKey?: unknown;
    agentType?: unknown;
    fallbackTarget: BackendTargetRefV1 | null;
}>): SerializedBackendTargetRouteParams {
    const resolvedTarget = params.fallbackTarget ?? resolveBackendTargetFromRouteParams(params);
    const resolvedTargetV2 = resolvedTarget ? readBackendTargetRefV2(resolvedTarget) : null;
    const routeParams: Partial<{
        agentType: AgentId;
        backendTarget: string;
        backendTargetKey: string;
    }> = {};

    if (resolvedTarget?.kind === 'builtInAgent') {
        routeParams.agentType = resolveBuiltInAgentIdForBackendTarget(resolvedTarget);
    } else if (!resolvedTarget && isAgentId(params.agentType)) {
        routeParams.agentType = params.agentType;
    }

    if (resolvedTargetV2) {
        routeParams.backendTarget = JSON.stringify(resolvedTargetV2);
        routeParams.backendTargetKey = buildBackendTargetKeyV2(resolvedTargetV2);
    } else {
        const serializedTarget = parseSerializedBackendTarget(params.backendTarget);
        if (serializedTarget) {
            routeParams.backendTarget = JSON.stringify(serializedTarget);
            routeParams.backendTargetKey = buildBackendTargetKeyV2(serializedTarget);
        } else {
            const parsedTargetKey = parseBackendTargetKeySafe(params.backendTargetKey);
            if (parsedTargetKey) {
                routeParams.backendTarget = JSON.stringify(parsedTargetKey);
                routeParams.backendTargetKey = buildBackendTargetKeyV2(parsedTargetKey);
            }
        }
    }

    return routeParams;
}

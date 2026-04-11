import {
    resolveAgentConfiguredRuntimeKind,
    resolveAgentRuntimeControlSurface,
    resolveAgentRuntimeControlSurfaceForSession,
    type AgentCoreRuntimeControlSurface,
    type AgentId,
} from '@happier-dev/agents';

type RuntimeSurfaceSessionContext = Readonly<{
    agentId: AgentId;
    metadata?: unknown;
    accountSettings?: Record<string, unknown> | null;
}>;

export function resolveEffectiveSessionRuntimeControlSurface(
    params: RuntimeSurfaceSessionContext,
): AgentCoreRuntimeControlSurface {
    return resolveAgentRuntimeControlSurfaceForSession({
        agentId: params.agentId,
        metadata: params.metadata ?? null,
        accountSettings: null,
    }) ?? resolveAgentRuntimeControlSurface(params.agentId, null);
}

export function resolveEffectiveConfiguredRuntimeControlSurface(
    params: Pick<RuntimeSurfaceSessionContext, 'agentId' | 'accountSettings'>,
): AgentCoreRuntimeControlSurface {
    const runtimeKind = resolveAgentConfiguredRuntimeKind({
        agentId: params.agentId,
        accountSettings: params.accountSettings ?? null,
    });

    return resolveAgentRuntimeControlSurface(params.agentId, runtimeKind);
}

export function supportsEffectiveLocalControlForSession(params: RuntimeSurfaceSessionContext): boolean {
    return resolveEffectiveSessionRuntimeControlSurface(params).localControl?.supported === true;
}

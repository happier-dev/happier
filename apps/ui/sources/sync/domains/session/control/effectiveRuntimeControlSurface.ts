import {
    resolveAgentConfiguredRuntimeKind,
    resolveAgentRuntimeControlSurface,
    type AgentCoreRuntimeControlSurface,
    type AgentId,
} from '@happier-dev/agents';

type RuntimeSurfaceSessionContext = Readonly<{
    agentId: AgentId;
    accountSettings?: Record<string, unknown> | null;
}>;

/**
 * Runtime control surface for the runtime kind an Agent is *configured* to
 * start on, which is what a settings screen previewing a not-yet-started
 * Session has to describe. An Agent with no bundled runtime contribution
 * resolves to `null`: its control surface is declared by its own plugin, not
 * borrowed from a bundled Agent.
 *
 * There is deliberately no per-Session variant here. A Session's effective
 * surface is owned by `resolveAgentRuntimeControlSurfaceForSession` in
 * `@happier-dev/agents`; the wrapper that used to live beside this one dropped
 * `accountSettings`, so the terminal surface and the session capabilities could
 * answer about two different runtime kinds for one Session.
 */
export function resolveEffectiveConfiguredRuntimeControlSurface(
    params: RuntimeSurfaceSessionContext,
): AgentCoreRuntimeControlSurface | null {
    const runtimeKind = resolveAgentConfiguredRuntimeKind({
        agentId: params.agentId,
        accountSettings: params.accountSettings ?? null,
    });

    return resolveAgentRuntimeControlSurface(params.agentId, runtimeKind);
}

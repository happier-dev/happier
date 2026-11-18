import { SessionAgentTransitionRequestV1Schema, SessionAgentTransitionResultV1Schema, type SessionAgentTransitionInputV1, type SessionAgentTransitionRequestV1, type SessionAgentTransitionResultV1 } from '@happier-dev/protocol/sessions/agentTransition';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions';
import { beginSessionAgentTransitionEffects } from '@happier-dev/protocol/sessions/agentTransitionEffectStage';

export type RunSessionAgentTransitionInput = Readonly<{
    machineId: string;
    serverId: string | null;
    request: SessionAgentTransitionRequestV1 & { input: SessionAgentTransitionInputV1 };
    signal?: AbortSignal;
}>;

/** Switching is an admitted Account Action; the raw machine mutation is retired. */
export async function runSessionAgentTransitionOnMachine(
    input: RunSessionAgentTransitionInput,
): Promise<SessionAgentTransitionResultV1 | ActionExecuteFailure> {
    const { v: _version, ...payload } = SessionAgentTransitionRequestV1Schema.parse(input.request);
    // This composer-only wrapper requires input even when the general Action does not.
    const effects = beginSessionAgentTransitionEffects({ localId: payload.input!.localId });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const outcome = await createDefaultActionExecutor().executeConfirmed('session.agent.transition', payload, {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
        defaultSessionId: payload.sessionId,
        ...(input.serverId ? { serverId: input.serverId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });
    // Keep admission/transport failures in the Action owner's vocabulary. They
    // do not establish one of the coordinator's effect-depth results.
    if (!outcome.ok) return outcome;
    const parsed = SessionAgentTransitionResultV1Schema.safeParse(outcome.result);
    return parsed.success ? parsed.data : effects.outcomeUnknown();
}

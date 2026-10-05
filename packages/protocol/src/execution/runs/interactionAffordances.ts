import type { ExecutionRunPublicState } from './responseSchemas.js';

/** Projection of the host's exact retained interaction and lifecycle, never Agent-id inference. */
export type ExecutionRunInteractionAffordances = Readonly<{
    isRetainedAgentSession: boolean;
    canSend: boolean;
    canSteer: boolean;
    canFollowUp: boolean;
    canCancelTurn: boolean;
    canResume: boolean;
}>;

export const NO_EXECUTION_RUN_INTERACTION: ExecutionRunInteractionAffordances = Object.freeze({
    isRetainedAgentSession: false, canSend: false, canSteer: false, canFollowUp: false,
    canCancelTurn: false, canResume: false,
});

type ExecutionRunInteractionProjectionShape = Readonly<{
    status?: unknown;
    interaction?: unknown;
    lifecycle?: unknown;
}>;

function readLifecycleState(run: ExecutionRunInteractionProjectionShape): string | null {
    const lifecycle = run.lifecycle;
    if (!lifecycle || typeof lifecycle !== 'object') return null;
    if ((lifecycle as { v?: unknown }).v !== 1) return null;
    const state = (lifecycle as { state?: unknown }).state;
    return typeof state === 'string' ? state : null;
}

function readRetainedCapabilities(run: ExecutionRunInteractionProjectionShape): {
    open: readonly string[]; delivery: readonly string[]; cancel: boolean;
} | null {
    const interaction = run.interaction;
    if (!interaction || typeof interaction !== 'object') return null;
    if ((interaction as { kind?: unknown }).kind !== 'retained_agent_session.v1') return null;
    const capabilities = (interaction as { capabilities?: unknown }).capabilities;
    if (!capabilities || typeof capabilities !== 'object') return null;
    const open = (capabilities as { open?: unknown }).open;
    const delivery = (capabilities as { delivery?: unknown }).delivery;
    return {
        open: Array.isArray(open) ? open.filter((value): value is string => typeof value === 'string') : [],
        delivery: Array.isArray(delivery) ? delivery.filter((value): value is string => typeof value === 'string') : [],
        cancel: (capabilities as { cancel?: unknown }).cancel === true,
    };
}

/** Live controls need a retained controller. Resume needs the host-proven recoverable lifecycle. */
export function resolveExecutionRunInteractionAffordances(
    run: ExecutionRunInteractionProjectionShape | ExecutionRunPublicState | null | undefined,
): ExecutionRunInteractionAffordances {
    if (!run || typeof run !== 'object') return NO_EXECUTION_RUN_INTERACTION;
    const canResume = readLifecycleState(run) === 'recoverable';
    const capabilities = readRetainedCapabilities(run);
    if (!capabilities) {
        return canResume ? Object.freeze({ ...NO_EXECUTION_RUN_INTERACTION, canResume: true }) : NO_EXECUTION_RUN_INTERACTION;
    }
    const status = typeof run.status === 'string' ? run.status.trim().toLowerCase() : '';
    if (status !== 'running') {
        return canResume ? Object.freeze({ ...NO_EXECUTION_RUN_INTERACTION, canResume: true }) : NO_EXECUTION_RUN_INTERACTION;
    }
    return Object.freeze({
        isRetainedAgentSession: true,
        canSend: capabilities.delivery.includes('newTurn'),
        canSteer: capabilities.delivery.includes('steer'),
        canFollowUp: capabilities.delivery.includes('followUp'),
        canCancelTurn: capabilities.cancel,
        canResume,
    });
}

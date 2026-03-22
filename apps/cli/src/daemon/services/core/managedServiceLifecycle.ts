import type { ManagedServiceLifecycleState } from './managedServiceTypes';

export type ManagedServiceLifecycleTransitionValidation = Readonly<{
    allowed: boolean;
    reason: 'same_state' | 'invalid_transition' | null;
}>;

const MANAGED_SERVICE_LIFECYCLE_GRAPH: Readonly<Record<ManagedServiceLifecycleState, readonly ManagedServiceLifecycleState[]>> = {
    stopped: ['starting'],
    starting: ['running', 'degraded', 'stopping', 'stopped', 'crashed'],
    running: ['degraded', 'stopping', 'crashed'],
    degraded: ['running', 'stopping', 'crashed'],
    stopping: ['stopped', 'crashed'],
    crashed: ['starting', 'stopped'],
};

export function getAllowedManagedServiceLifecycleTransitions(
    state: ManagedServiceLifecycleState,
): readonly ManagedServiceLifecycleState[] {
    return MANAGED_SERVICE_LIFECYCLE_GRAPH[state];
}

export function validateManagedServiceLifecycleTransition(params: Readonly<{
    from: ManagedServiceLifecycleState;
    to: ManagedServiceLifecycleState;
}>): ManagedServiceLifecycleTransitionValidation {
    if (params.from === params.to) {
        return {
            allowed: false,
            reason: 'same_state',
        };
    }

    const allowed = MANAGED_SERVICE_LIFECYCLE_GRAPH[params.from].includes(params.to);

    return {
        allowed,
        reason: allowed ? null : 'invalid_transition',
    };
}

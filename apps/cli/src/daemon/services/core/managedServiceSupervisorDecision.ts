import { deriveManagedServiceHealth, type ManagedServiceHealth } from './managedServiceHealth';
import { createManagedServiceRestartDecision } from './managedServiceRestartPolicy';
import type {
    ManagedServiceLifecycleState,
    ManagedServiceRestartDecision,
    ManagedServiceRestartPolicy,
} from './managedServiceTypes';

type RestartAfterDelayDecision = Extract<ManagedServiceRestartDecision, { type: 'restart_after_delay' }>;
type DoNotRestartDecision = Extract<ManagedServiceRestartDecision, { type: 'do_not_restart' }>;

export type ManagedServiceSupervisorAction =
    | Readonly<{
        type: 'start';
        health: ManagedServiceHealth;
    }>
    | Readonly<{
        type: 'wait';
        health: ManagedServiceHealth;
    }>
    | Readonly<{
        type: 'restart_after_delay';
        restartDecision: RestartAfterDelayDecision;
        health: ManagedServiceHealth;
    }>
    | Readonly<{
        type: 'do_not_restart';
        restartDecision: DoNotRestartDecision;
        health: ManagedServiceHealth;
    }>;

export function decideManagedServiceSupervisorAction(params: Readonly<{
    lifecycleState: ManagedServiceLifecycleState;
    completedRestartCount: number;
    restartPolicy: ManagedServiceRestartPolicy;
    random: () => number;
}>): ManagedServiceSupervisorAction {
    if (params.lifecycleState === 'stopped') {
        return {
            type: 'start',
            health: deriveManagedServiceHealth({ lifecycleState: 'stopped' }),
        };
    }

    if (params.lifecycleState !== 'crashed') {
        return {
            type: 'wait',
            health: deriveManagedServiceHealth({ lifecycleState: params.lifecycleState }),
        };
    }

    const restartDecision = createManagedServiceRestartDecision({
        policy: params.restartPolicy,
        completedRestartCount: params.completedRestartCount,
        random: params.random,
    });

    const health = deriveManagedServiceHealth({
        lifecycleState: 'crashed',
        lastRestartDecision: restartDecision,
    });

    if (restartDecision.type === 'restart_after_delay') {
        return {
            type: 'restart_after_delay',
            restartDecision,
            health,
        };
    }

    return {
        type: 'do_not_restart',
        restartDecision,
        health,
    };
}

import type { ManagedServiceLifecycleState, ManagedServiceRestartDecision } from './managedServiceTypes';

export type ManagedServiceHealthStatus = 'healthy' | 'pending' | 'degraded' | 'offline';

export type ManagedServiceHealthReason =
    | 'starting'
    | 'stopping'
    | 'lifecycle_degraded'
    | 'restart_scheduled'
    | 'restart_exhausted'
    | 'stopped'
    | 'crashed'
    | null;

export type ManagedServiceHealth = Readonly<{
    status: ManagedServiceHealthStatus;
    isDegraded: boolean;
    reason: ManagedServiceHealthReason;
}>;

export function deriveManagedServiceHealth(params: Readonly<{
    lifecycleState: ManagedServiceLifecycleState;
    lastRestartDecision?: ManagedServiceRestartDecision;
}>): ManagedServiceHealth {
    if (params.lifecycleState === 'running') {
        return {
            status: 'healthy',
            isDegraded: false,
            reason: null,
        };
    }

    if (params.lifecycleState === 'starting' || params.lifecycleState === 'stopping') {
        return {
            status: 'pending',
            isDegraded: false,
            reason: params.lifecycleState,
        };
    }

    if (params.lifecycleState === 'degraded') {
        return {
            status: 'degraded',
            isDegraded: true,
            reason: 'lifecycle_degraded',
        };
    }

    if (params.lifecycleState === 'stopped') {
        return {
            status: 'offline',
            isDegraded: false,
            reason: 'stopped',
        };
    }

    if (params.lastRestartDecision?.type === 'restart_after_delay') {
        return {
            status: 'degraded',
            isDegraded: true,
            reason: 'restart_scheduled',
        };
    }

    if (params.lastRestartDecision?.type === 'do_not_restart') {
        return {
            status: 'offline',
            isDegraded: false,
            reason: 'restart_exhausted',
        };
    }

    return {
        status: 'offline',
        isDegraded: false,
        reason: 'crashed',
    };
}

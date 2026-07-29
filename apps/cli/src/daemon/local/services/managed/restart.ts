export type ManagedLocalServiceRestartPolicy =
    | Readonly<{ kind: 'never' }>
    | Readonly<{ kind: 'manual'; strategy: 'same_launch' }>;

export type ManagedLocalServiceRestartDecision =
    | Readonly<{
        ok: true;
    }>
    | Readonly<{
        ok: false;
        reason:
            | 'restart_not_configured'
            | 'restart_launch_intent_unavailable'
            | 'restart_owner_unavailable'
            | 'restart_launch_mode_unsupported'
            | 'restart_runtime_unavailable'
            | 'restart_signal_aborted';
        diagnostic: Readonly<{ code: ManagedLocalServiceRestartDecisionReason; severity: 'warning' }>;
    }>;

export type ManagedLocalServiceRestartDecisionReason = Exclude<
    ManagedLocalServiceRestartDecision,
    Readonly<{ ok: true }>
>['reason'];

function denied(reason: ManagedLocalServiceRestartDecisionReason): ManagedLocalServiceRestartDecision {
    return {
        ok: false,
        reason,
        diagnostic: { code: reason, severity: 'warning' },
    };
}

export function resolveManagedLocalServiceRestartRequest(_input: Readonly<{
    serviceId: string;
    policy: ManagedLocalServiceRestartPolicy;
}>): ManagedLocalServiceRestartDecision {
    if (_input.policy.kind === 'never') {
        return denied('restart_not_configured');
    }
    return { ok: true };
}

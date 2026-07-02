export type ManagedLocalServiceRestartPolicy = Readonly<{ kind: 'never' }>;

export type ManagedLocalServiceRestartDecision =
    | Readonly<{
        ok: false;
        reason: 'restart_not_configured';
        diagnostic: Readonly<{ code: 'restart_not_configured'; severity: 'warning' }>;
    }>;

export function resolveManagedLocalServiceRestartRequest(_input: Readonly<{
    serviceId: string;
    policy: ManagedLocalServiceRestartPolicy;
}>): ManagedLocalServiceRestartDecision {
    return {
        ok: false,
        reason: 'restart_not_configured',
        diagnostic: { code: 'restart_not_configured', severity: 'warning' },
    };
}

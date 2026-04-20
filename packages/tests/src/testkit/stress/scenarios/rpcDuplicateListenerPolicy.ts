export type RpcDuplicateListenerScope = 'user' | 'session' | 'machine';

export type RpcDuplicateListenerOutcome = 'rejected' | 'deterministic' | 'ambiguous';

export type RpcDuplicateListenerScopeCase = Readonly<{
  scope: RpcDuplicateListenerScope;
  method: string;
}>;

export function buildRpcDuplicateListenerScopeCases(params: Readonly<{
  sessionId: string;
  machineId: string;
}>): readonly RpcDuplicateListenerScopeCase[] {
  return [
    {
      scope: 'user',
      method: 'stress.duplicate-policy.user',
    },
    {
      scope: 'session',
      method: `${params.sessionId}:stress.duplicate-policy.session`,
    },
    {
      scope: 'machine',
      method: `${params.machineId}:stress.duplicate-policy.machine`,
    },
  ];
}

export function classifyRpcDuplicateListenerOutcome(params: Readonly<{
  secondRegistrationRejected: boolean;
  responderIds: ReadonlySet<string>;
}>): RpcDuplicateListenerOutcome {
  if (params.secondRegistrationRejected) {
    return 'rejected';
  }
  if (params.responderIds.size > 1) {
    return 'ambiguous';
  }
  return 'deterministic';
}

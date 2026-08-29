import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

export type ConnectedServiceBindingRef = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
}>;

export type ConnectedServiceSpawnTargetRef = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  sessionId?: string | null;
  materializationKey?: string | null;
}>;

export async function settleConnectedServiceCredentialDeletion(params: Readonly<{
  binding: ConnectedServiceBindingRef;
  affectedTargets: ReadonlyArray<ConnectedServiceSpawnTargetRef>;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  isCredentialTargetPresent: (input: Readonly<{
    target: ConnectedServiceSpawnTargetRef;
    binding: ConnectedServiceBindingRef;
  }>) => boolean;
}>): Promise<void> {
  const targetsBySessionId = new Map<string, ConnectedServiceSpawnTargetRef[]>();
  for (const target of params.affectedTargets) {
    const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
    if (!sessionId) {
      throw new Error('connected_service_credential_deletion_target_session_unavailable');
    }
    const targets = targetsBySessionId.get(sessionId) ?? [];
    targets.push(target);
    targetsBySessionId.set(sessionId, targets);
  }

  for (const [sessionId, targets] of targetsBySessionId) {
    const result = await params.stopSession(sessionId);
    const exactTargetsAbsent = targets.every((target) => !params.isCredentialTargetPresent({
      target,
      binding: params.binding,
    }));
    if (
      (result.status !== 'stopped' && result.status !== 'not_found')
      || !exactTargetsAbsent
    ) {
      throw new Error(`connected_service_credential_deletion_not_settled:${result.status}`);
    }
  }
}

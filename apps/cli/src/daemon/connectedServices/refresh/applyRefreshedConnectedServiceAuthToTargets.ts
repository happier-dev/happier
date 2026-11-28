import type { ConnectedServiceCredentialRevisionV1, ConnectedServiceId } from '@happier-dev/protocol';

import type { SessionConnectedServiceAuthSwitchDiagnostics } from '../sessionAuthSwitch/switchSessionConnectedServiceAuth';
import type { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';

type AuthUpdatedHandler = NonNullable<
  ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onAuthUpdated']
>;
type AuthUpdatedEvent = Parameters<AuthUpdatedHandler>[0];

type DeferredRefreshRestart = Readonly<{
  target: AuthUpdatedEvent['affectedTargets'][number];
  reason: 'adapter_restart_required' | 'lifecycle_policy';
}>;

export type ApplyRefreshedConnectedServiceAuth = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  activeProfileId: string | null;
  generation: number | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  reason: string;
  switchReason: ConnectedServiceSessionAuthSwitchReason;
  fromProfileId?: string | null;
}>) => Promise<Readonly<{
  ok: boolean;
  action?: string;
  errorCode?: string;
  diagnostics?: SessionConnectedServiceAuthSwitchDiagnostics | Readonly<{ continuity: unknown }>;
}>>;

/**
 * Applies a refreshed credential to every live session that uses the refreshed profile, by hot
 * apply, and reports which runtimes accepted it. Failures that mean "this session needs something
 * other than a hot apply" are not errors here: the restart handler that runs after this decides,
 * per provider policy, whether the session restarts or already reads the credential live.
 */
export async function applyRefreshedConnectedServiceAuthToTargets(params: Readonly<{
  event: Pick<AuthUpdatedEvent, 'binding' | 'affectedTargets' | 'credentialRevision' | 'trigger'>;
  applyAuth: ApplyRefreshedConnectedServiceAuth;
}>): Promise<Readonly<{
  appliedRuntimeIdentityKeys: Set<string>;
  restartTargets: readonly DeferredRefreshRestart[];
}>> {
  const { event } = params;
  const attemptedSessionIds = new Set<string>();
  const restartTargets: DeferredRefreshRestart[] = [];
  const appliedRuntimeIdentityKeys = new Set<string>();
  for (const target of event.affectedTargets) {
    const sessionId = String(target.sessionId ?? '').trim();
    if (!sessionId || attemptedSessionIds.has(sessionId)) continue;
    const selection = target.selectionsByServiceId.get(event.binding.serviceId);
    if (!selection) continue;
    const activeProfileId = selection.kind === 'profile'
      ? selection.profileId
      : selection.activeProfileId;
    if (activeProfileId !== event.binding.profileId) continue;

    attemptedSessionIds.add(sessionId);
    const result = await params.applyAuth({
      sessionId,
      serviceId: event.binding.serviceId,
      groupId: selection.kind === 'group' ? selection.groupId : null,
      activeProfileId,
      generation: selection.kind === 'group' ? selection.generation : null,
      credentialRevision: event.credentialRevision,
      reason: event.trigger,
      switchReason: 'automatic_runtime_failure',
      fromProfileId: activeProfileId,
    });
    if (!result.ok) {
      const diagnostics = result.diagnostics;
      const serviceResult = diagnostics && 'serviceResultsByServiceId' in diagnostics
        ? diagnostics.serviceResultsByServiceId?.[event.binding.serviceId]
        : undefined;
      const partialState = diagnostics && 'partialState' in diagnostics ? diagnostics.partialState : undefined;
      if (result.errorCode === 'hot_apply_failed' && !partialState
        && serviceResult?.status === 'failed' && serviceResult.errorCode === 'hot_apply_restart_required') {
        restartTargets.push({ target, reason: 'adapter_restart_required' });
        continue;
      }
      if (
        result.errorCode === 'restart_disallowed_by_execution_policy'
        || result.errorCode === 'hot_apply_restart_required'
      ) {
        restartTargets.push({ target, reason: 'lifecycle_policy' });
        continue;
      }
      throw new Error(`connected_service_refreshed_auth_application_failed:${result.errorCode ?? 'unknown'}`);
    }
    if (result.action === 'metadata_updated') {
      restartTargets.push({ target, reason: 'lifecycle_policy' });
      continue;
    }
    if (result.action !== 'hot_applied') continue;
    for (const affectedTarget of event.affectedTargets) {
      if (
        affectedTarget.sessionId === sessionId
        && affectedTarget.pid === target.pid
      ) {
        appliedRuntimeIdentityKeys.add(affectedTarget.runtimeIdentityKey);
      }
    }
  }
  return { appliedRuntimeIdentityKeys, restartTargets };
}

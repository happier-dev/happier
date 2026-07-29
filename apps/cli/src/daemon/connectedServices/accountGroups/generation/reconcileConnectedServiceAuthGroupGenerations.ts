import type { ConnectedServiceId } from '@happier-dev/protocol';

import { parseConnectedServiceBindingSelections } from '../../parseConnectedServicesBindings';
import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  buildConnectedServiceAuthGroupTargetEpochIdentity,
  type ConnectedServiceGenerationExecutionAuthority,
  type ConnectedServiceProviderAdoptedGenerationTarget,
} from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';
import type { ConnectedServiceProjectedCredentialPresence } from './connectedServiceProjectionSnapshot';

export type ConnectedServiceGenerationRuntimeTarget = Readonly<{
  sessionId: string | null;
  agentId?: string | null;
  connectedServiceMaterializationIdentityV1?: Readonly<{ id: string }> | null;
  connectedServicesBindingsRaw: unknown;
  activeBindings: ReadonlyArray<Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string | null;
    profileId: string;
    generation: number | null;
    credentialRevision?: string | null;
  }>>;
}>;

export type ConnectedServiceProjectedAuthGroup = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string | null;
  generation: number;
}>;

export class ConnectedServiceGenerationReconciliationNotAcknowledgeableError extends Error {
  constructor() {
    super('connected_service_generation_reconciliation_not_acknowledgeable');
    this.name = 'ConnectedServiceGenerationReconciliationNotAcknowledgeableError';
  }
}

export function isConnectedServiceGenerationReconciliationNotAcknowledgeableError(
  error: unknown,
): error is ConnectedServiceGenerationReconciliationNotAcknowledgeableError {
  return error instanceof ConnectedServiceGenerationReconciliationNotAcknowledgeableError;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function groupScopeKey(input: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>): string {
  return `${input.serviceId}\0${input.groupId}`;
}

export async function reconcileConnectedServiceDirectCredentialRevisions(params: Readonly<{
  credentialRevisions: ReadonlyArray<Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialRevision: string;
  }>>;
  resolveCredentialPresence?: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => ConnectedServiceProjectedCredentialPresence;
  listRuntimeTargets: () => readonly ConnectedServiceGenerationRuntimeTarget[];
  applyLiveCredentialRevision: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialPresence: Exclude<ConnectedServiceProjectedCredentialPresence, Readonly<{ status: 'legacy_unfenced' }>>;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  }>) => Promise<void>;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  signal?: AbortSignal;
}>): Promise<Readonly<{ acknowledgeable: true; pendingSessionCount: 0; appliedBindingCount: number }>> {
  params.signal?.throwIfAborted();
  const revisions = new Map(params.credentialRevisions.map((entry) => [
    `${entry.serviceId}\0${entry.profileId}`,
    entry.credentialRevision,
  ] as const));
  const liveBindings = new Map<string, Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialPresence: Exclude<ConnectedServiceProjectedCredentialPresence, Readonly<{ status: 'legacy_unfenced' }>>;
  }>>();
  for (const target of params.listRuntimeTargets()) {
    for (const selection of parseConnectedServiceBindingSelections(target.connectedServicesBindingsRaw)) {
      if (selection.kind !== 'profile') continue;
      const credentialPresence = params.resolveCredentialPresence?.(selection.serviceId, selection.profileId)
        ?? (
          revisions.has(`${selection.serviceId}\0${selection.profileId}`)
            ? {
                status: 'present' as const,
                credentialRevision: revisions.get(`${selection.serviceId}\0${selection.profileId}`)!,
              }
            : { status: 'legacy_unfenced' as const }
        );
      if (credentialPresence.status === 'legacy_unfenced') continue;
      liveBindings.set(`${selection.serviceId}\0${selection.profileId}`, {
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        credentialPresence,
      });
    }
  }
  const outcomes = await Promise.allSettled([...liveBindings.values()].map(async (binding) => {
    params.signal?.throwIfAborted();
    await params.applyLiveCredentialRevision({ ...binding, executionAuthority: params.executionAuthority });
  }));
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  params.signal?.throwIfAborted();
  return { acknowledgeable: true, pendingSessionCount: 0, appliedBindingCount: liveBindings.size };
}

export async function reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget(params: Readonly<{
  target: ConnectedServiceGenerationRuntimeTarget;
  providerAdoptedTargets?: readonly ConnectedServiceProviderAdoptedGenerationTarget[];
  consumer: ConnectedServiceAuthGroupGenerationConsumer;
  listCurrentGroups: (serviceId: ConnectedServiceId) => Promise<readonly ConnectedServiceProjectedAuthGroup[]>;
  resolveCredentialRevision: (serviceId: ConnectedServiceId, profileId: string) => string | null;
  resolveCredentialPresence: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => ConnectedServiceProjectedCredentialPresence;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
}>) {
  const sessionId = readNonEmptyString(params.target.sessionId);
  if (!sessionId) {
    return { acknowledgeable: true, reconciledGroupCount: 0, sessionDispositionCount: 0 } as const;
  }
  const scopes = new Map<string, Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    fromProfileId: string | null;
  }>>();
  for (const selection of parseConnectedServiceBindingSelections(params.target.connectedServicesBindingsRaw)) {
    if (selection.kind !== 'group') continue;
    scopes.set(groupScopeKey(selection), {
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      fromProfileId: selection.fallbackProfileId ?? null,
    });
  }
  for (const binding of params.target.activeBindings) {
    const groupId = readNonEmptyString(binding.groupId);
    if (!groupId) continue;
    scopes.set(groupScopeKey({ serviceId: binding.serviceId, groupId }), {
      serviceId: binding.serviceId,
      groupId,
      fromProfileId: binding.profileId,
    });
  }
  const adoptedByScope = new Map((params.providerAdoptedTargets ?? []).map((target) => [
    groupScopeKey(target),
    target,
  ] as const));
  const materializedByScope = new Map(params.target.activeBindings.flatMap((binding) => {
    const groupId = readNonEmptyString(binding.groupId);
    const materializationId = readNonEmptyString(params.target.connectedServiceMaterializationIdentityV1?.id);
    if (
      !materializationId
      || !groupId
      || binding.generation === null
    ) return [];
    return [[groupScopeKey({ serviceId: binding.serviceId, groupId }), binding] as const];
  }));
  const serviceIds = [...new Set([...scopes.values()].map((scope) => scope.serviceId))];
  const groupsByScope = new Map<string, ConnectedServiceProjectedAuthGroup>();
  await Promise.all(serviceIds.map(async (serviceId) => {
    for (const group of await params.listCurrentGroups(serviceId)) {
      if (group.serviceId !== serviceId) throw new Error('connected_service_auth_group_list_scope_mismatch');
      groupsByScope.set(groupScopeKey(group), group);
    }
  }));

  let reconciledGroupCount = 0;
  let sessionDispositionCount = 0;
  for (const [key, scope] of scopes) {
    const group = groupsByScope.get(key);
    const activeProfileId = readNonEmptyString(group?.activeProfileId);
    if (!group || !activeProfileId) {
      const result = await params.consumer.consumeUnavailable({
        serviceId: scope.serviceId,
        groupId: scope.groupId,
        sessions: [{ sessionId, activity: 'live' }],
      });
      if (!result.acknowledgeable) throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
      sessionDispositionCount += result.recordedSessionCount;
      continue;
    }
    const credentialRevision = params.resolveCredentialRevision(group.serviceId, activeProfileId);
    const credentialPresence = params.resolveCredentialPresence(group.serviceId, activeProfileId);
    const adopted = adoptedByScope.get(key) ?? null;
    const materialized = materializedByScope.get(key) ?? null;
    const exactAdoptedTarget = credentialPresence.status === 'present'
      && credentialRevision !== null
      && adopted
      && adopted.profileId === activeProfileId
      && adopted.generation === group.generation
      && adopted.credentialRevision === credentialRevision
      && adopted.proof.credentialRevision === credentialRevision
        ? adopted
        : null;
    if (exactAdoptedTarget) {
      const settlement = await params.consumer.settleExactRecipientApplication({
        sessionId,
        providerAdoptedTarget: exactAdoptedTarget,
      });
      if (settlement?.status === 'superseded') {
        throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
      }
      continue;
    }
    if (
      (
        credentialPresence.status === 'present'
        && credentialRevision !== null
        && (materialized
          && materialized.profileId === activeProfileId
          && materialized.generation === group.generation
          && materialized.credentialRevision === credentialRevision)
      )
      || (
        credentialPresence.status === 'legacy_unfenced'
        && materialized
        && materialized.profileId === activeProfileId
        && materialized.generation === group.generation
        && materialized.credentialRevision == null
      )
    ) continue;
    const decisionCommittedTarget = {
      serviceId: group.serviceId,
      groupId: group.groupId,
      profileId: activeProfileId,
      generation: group.generation,
      credentialRevision,
    } as const;
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(decisionCommittedTarget),
      provenance: 'reconciliation',
      requestedTarget: { profileId: activeProfileId },
      decisionCommittedTarget,
    });
    const result = await params.consumer.consume({
      committedGeneration,
      switchReason: 'manual',
      executionAuthority: params.executionAuthority,
      sessions: [{
        sessionId,
        activity: 'live',
        fromProfileId: scope.fromProfileId,
        applicationOwnerId: readNonEmptyString(params.target.agentId),
      }],
    });
    if (!result.acknowledgeable) throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
    reconciledGroupCount += 1;
    sessionDispositionCount += 1;
  }
  return { acknowledgeable: true, reconciledGroupCount, sessionDispositionCount } as const;
}

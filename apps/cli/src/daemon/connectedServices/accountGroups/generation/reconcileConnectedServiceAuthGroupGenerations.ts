import type { ConnectedServiceCredentialRevisionV1, ConnectedServiceId } from '@happier-dev/protocol';
import { parseConnectedServiceBindingSelections } from '../../parseConnectedServicesBindings';
import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  buildConnectedServiceAuthGroupTargetEpochIdentity,
  type ConnectedServiceAuthGroupGenerationTarget,
  type ConnectedServiceProviderAdoptedGenerationTarget,
} from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';
import type { ConnectedServiceRuntimeTargetRegistration } from '../../runtimeRegistry/registry';
import type { ConnectedServiceGenerationExecutionAuthority } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type {
  ConnectedServiceProjectedAuthGroup,
  ConnectedServiceProjectedCredential,
  ConnectedServiceProjectedCredentialBoundary,
} from './connectedServiceProjectionSnapshot';

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

export type ConnectedServiceGenerationRuntimeTarget = Readonly<{
  sessionId: string | null;
  agentId?: string | null;
  brokerSelectionIdentity?: string | null;
  connectedServicesBindingsRaw: unknown;
  activeBindings: ReadonlyArray<Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string | null;
    profileId: string;
    generation: number | null;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>>;
  runtimeIdentityKey?: string;
  revision?: number;
  connectedServiceMaterializationIdentityV1?: Readonly<{ id: string }> | null;
}>;

export function listSessionGenerationRuntimeTargets(
  registrations: readonly ConnectedServiceRuntimeTargetRegistration[],
): ConnectedServiceGenerationRuntimeTarget[] {
  // Runs retain their parent's sessionId, but cannot receive a session auth application.
  return registrations.flatMap((registration) => registration.key.kind === 'session' ? [registration.target] : []);
}

type ConnectedServiceAuthGroupRuntimeScope = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  fromProfileId: string | null;
  applicationSettledProfileId: string | null;
  applicationSettledGeneration: number | null;
  applicationSettledCredentialRevision: string | null;
  applicationSettledBySpawnMaterialization: boolean;
  applicationOwnerId: string | null;
  isCurrent: () => boolean;
}>;

type ConnectedServiceDirectCredentialRevisionRuntimeScope = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  isCurrent: () => boolean;
}>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function sessionScopeKey(input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
}>): string {
  return `${input.sessionId}\0${input.serviceId}\0${input.groupId}`;
}

function groupScopeKey(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
}>): string {
  return `${input.serviceId}\0${input.groupId}`;
}

function listRuntimeSessionScopes(
  runtimeTargets: readonly ConnectedServiceGenerationRuntimeTarget[],
  isCurrentRuntimeTarget: (target: ConnectedServiceGenerationRuntimeTarget) => boolean = () => true,
): ConnectedServiceAuthGroupRuntimeScope[] {
  const byKey = new Map<string, ConnectedServiceAuthGroupRuntimeScope>();
  for (const target of runtimeTargets) {
    const isCurrent = () => isCurrentRuntimeTarget(target);
    if (!isCurrent()) continue;
    const sessionId = readNonEmptyString(target.sessionId);
    if (!sessionId) continue;
    const runtimeBindings = target.activeBindings.flatMap((binding) => {
      const groupId = readNonEmptyString(binding.groupId);
      return groupId ? [{
        serviceId: binding.serviceId,
        groupId,
        fromProfileId: binding.profileId,
      }] : [];
    });
    const discoveredBindings = parseConnectedServiceBindingSelections(target.connectedServicesBindingsRaw)
      .filter((selection): selection is Extract<typeof selection, { kind: 'group' }> => selection.kind === 'group')
      .map((selection) => ({
        serviceId: selection.serviceId,
        groupId: selection.groupId,
        fromProfileId: selection.fallbackProfileId ?? null,
      }));
    for (const binding of [...discoveredBindings, ...runtimeBindings]) {
      const key = sessionScopeKey({ sessionId, serviceId: binding.serviceId, groupId: binding.groupId });
      const scope: ConnectedServiceAuthGroupRuntimeScope = {
        sessionId,
        serviceId: binding.serviceId,
        groupId: binding.groupId,
        // `live` means the runner is reachable in the runtime registry. It is deliberately
        // independent of turn activity: an online-but-idle Codex runner hot-applies immediately.
        fromProfileId: binding.fromProfileId,
        // Runtime selections are desired materialization, not provider-adoption proof. Registration
        // replay supplies fresh proof separately when it has one.
        applicationSettledProfileId: null,
        applicationSettledGeneration: null,
        applicationSettledCredentialRevision: null,
        applicationSettledBySpawnMaterialization: false,
        applicationOwnerId: readNonEmptyString(target.agentId),
        isCurrent,
      };
      byKey.set(key, scope);
    }
  }
  return [...byKey.values()].sort((left, right) => sessionScopeKey(left).localeCompare(sessionScopeKey(right)));
}

async function listCurrentConnectedServiceAuthGroupSessionScopes(params: Readonly<{
  listRuntimeTargets: () => readonly ConnectedServiceGenerationRuntimeTarget[];
  isCurrentRuntimeTarget?: (target: ConnectedServiceGenerationRuntimeTarget) => boolean;
}>): Promise<readonly ConnectedServiceAuthGroupRuntimeScope[]> {
  return listRuntimeSessionScopes(params.listRuntimeTargets(), params.isCurrentRuntimeTarget);
}

async function listCurrentConnectedServiceDirectCredentialScopes(params: Readonly<{
  listRuntimeTargets: () => readonly ConnectedServiceGenerationRuntimeTarget[];
  isCurrentRuntimeTarget?: (target: ConnectedServiceGenerationRuntimeTarget) => boolean;
}>): Promise<readonly ConnectedServiceDirectCredentialRevisionRuntimeScope[]> {
  const byScope = new Map<string, ConnectedServiceDirectCredentialRevisionRuntimeScope>();
  const add = (scope: ConnectedServiceDirectCredentialRevisionRuntimeScope) => {
    const key = `${scope.sessionId}\0${scope.serviceId}\0${scope.profileId}`;
    byScope.set(key, scope);
  };
  for (const target of params.listRuntimeTargets()) {
    const isCurrent = () => params.isCurrentRuntimeTarget?.(target) !== false;
    if (!isCurrent()) continue;
    const sessionId = readNonEmptyString(target.sessionId);
    if (!sessionId) continue;
    for (const selection of parseConnectedServiceBindingSelections(target.connectedServicesBindingsRaw)) {
      if (selection.kind !== 'profile') continue;
      add({ sessionId, serviceId: selection.serviceId, profileId: selection.profileId, isCurrent });
    }
  }
  return [...byScope.values()].sort((left, right) => (
    `${left.sessionId}\0${left.serviceId}\0${left.profileId}`
      .localeCompare(`${right.sessionId}\0${right.serviceId}\0${right.profileId}`)
  ));
}

export async function reconcileConnectedServiceDirectCredentialRevisions(params: Readonly<{
  credentialBoundaries: readonly ConnectedServiceProjectedCredential[];
  listRuntimeTargets: () => readonly ConnectedServiceGenerationRuntimeTarget[];
  isCurrentRuntimeTarget?: (target: ConnectedServiceGenerationRuntimeTarget) => boolean;
  applyLiveCredentialBoundary: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialBoundary: ConnectedServiceProjectedCredentialBoundary;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  }>) => Promise<void>;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  signal?: AbortSignal;
}>): Promise<Readonly<{ acknowledgeable: true; appliedBindingCount: number }>> {
  params.signal?.throwIfAborted();
  const allScopes = await listCurrentConnectedServiceDirectCredentialScopes({
    listRuntimeTargets: params.listRuntimeTargets,
    ...(params.isCurrentRuntimeTarget ? { isCurrentRuntimeTarget: params.isCurrentRuntimeTarget } : {}),
  });
  params.signal?.throwIfAborted();
  const boundaries = new Map(params.credentialBoundaries.map((entry) => [
    `${entry.serviceId}\0${entry.profileId}`,
    entry,
  ] as const));
  const scopes = allScopes.filter((scope) => boundaries.has(`${scope.serviceId}\0${scope.profileId}`));
  params.signal?.throwIfAborted();
  const liveBindings = new Map<string, {
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialBoundary: ConnectedServiceProjectedCredentialBoundary;
    isCurrent: () => boolean;
  }>();
  for (const scope of scopes) {
    if (!scope.isCurrent()) continue;
    const projected = boundaries.get(`${scope.serviceId}\0${scope.profileId}`);
    if (!projected) continue;
    const bindingKey = `${scope.serviceId}\0${scope.profileId}`;
    const previous = liveBindings.get(bindingKey);
    liveBindings.set(bindingKey, {
      serviceId: scope.serviceId,
      profileId: scope.profileId,
      credentialBoundary: projected.boundary,
      isCurrent: previous
        ? () => previous.isCurrent() || scope.isCurrent()
        : scope.isCurrent,
    });
  }
  params.signal?.throwIfAborted();
  const liveOutcomes = await Promise.allSettled([...liveBindings.values()].map(async (binding) => {
    if (!binding.isCurrent()) return false;
    const { isCurrent: _isCurrent, ...credential } = binding;
    await params.applyLiveCredentialBoundary({ ...credential, executionAuthority: params.executionAuthority });
    return true;
  }));
  const liveFailure = liveOutcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (liveFailure) throw liveFailure.reason;
  params.signal?.throwIfAborted();
  return {
    acknowledgeable: true,
    appliedBindingCount: liveOutcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value).length,
  };
}

/**
 * Reconcile one newly reachable runtime target against the latest direct-profile projection.
 * Registration replay targets only the newly reachable runtime. The existing live refresh owner
 * remains the only direct-credential effect.
 */
export async function reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget(params: Readonly<{
  target: ConnectedServiceGenerationRuntimeTarget;
  resolveCredentialBoundary: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => ConnectedServiceProjectedCredentialBoundary;
  applyLiveCredentialBoundary: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialBoundary: ConnectedServiceProjectedCredentialBoundary;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  }>) => Promise<void>;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
}>): Promise<Readonly<{ appliedBindingCount: number }>> {
  params.signal?.throwIfAborted();
  if (params.isCurrent && !params.isCurrent()) return { appliedBindingCount: 0 };
  const bindings = new Map<string, Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialBoundary: ConnectedServiceProjectedCredentialBoundary;
  }>>();
  for (const binding of params.target.activeBindings) {
    if (binding.groupId !== null) continue;
    const credentialBoundary = params.resolveCredentialBoundary(binding.serviceId, binding.profileId);
    // A present exact-0.2.1 credential remains valid but has no CAS revision to compare.
    if (
      credentialBoundary.status === 'present'
      && credentialBoundary.revisionSemantics === 'legacy_unfenced'
    ) continue;
    if (
      credentialBoundary.status === 'present'
      && credentialBoundary.credentialRevision === (binding.credentialRevision ?? null)
    ) continue;
    bindings.set(`${binding.serviceId}\0${binding.profileId}`, {
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      credentialBoundary,
    });
  }
  let appliedBindingCount = 0;
  for (const binding of bindings.values()) {
    params.signal?.throwIfAborted();
    if (params.isCurrent && !params.isCurrent()) break;
    await params.applyLiveCredentialBoundary({
      ...binding,
      executionAuthority: params.executionAuthority,
    });
    appliedBindingCount += 1;
  }
  params.signal?.throwIfAborted();
  return { appliedBindingCount };
}

async function reconcileKnownConnectedServiceAuthGroupScopes(params: Readonly<{
  scopes: readonly ConnectedServiceAuthGroupRuntimeScope[];
  consumer: ConnectedServiceAuthGroupGenerationConsumer;
  listCurrentGroups: (serviceId: ConnectedServiceId) => Promise<readonly ConnectedServiceProjectedAuthGroup[]>;
  resolveCredentialRevision: (serviceId: ConnectedServiceId, profileId: string) => string | null;
  resolveCredentialBoundary?: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => ConnectedServiceProjectedCredentialBoundary;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  acknowledgeable: true;
  reconciledGroupCount: number;
  sessionDispositionCount: number;
}>> {
  const scopes = params.scopes;
  params.signal?.throwIfAborted();
  const serviceIds = [...new Set(scopes.map((scope) => scope.serviceId))];
  const groupsByScope = new Map<string, ConnectedServiceProjectedAuthGroup>();
  await Promise.all(serviceIds.map(async (serviceId) => {
    const groups = await params.listCurrentGroups(serviceId);
    params.signal?.throwIfAborted();
    for (const group of groups) {
      if (group.serviceId !== serviceId) {
        throw new Error('connected_service_auth_group_list_scope_mismatch');
      }
      groupsByScope.set(groupScopeKey(group), group);
    }
  }));

  let reconciledGroupCount = 0;
  let sessionDispositionCount = 0;
  const scopesByGroup = new Map<string, ConnectedServiceAuthGroupRuntimeScope[]>();
  for (const scope of scopes) {
    if (!scope.isCurrent()) continue;
    const key = groupScopeKey(scope);
    const members = scopesByGroup.get(key) ?? [];
    members.push(scope);
    scopesByGroup.set(key, members);
  }
  for (const [key, sessions] of scopesByGroup) {
    params.signal?.throwIfAborted();
    const currentSessions = sessions.filter((session) => session.isCurrent());
    if (currentSessions.length === 0) continue;
    const group = groupsByScope.get(key);
    const activeProfileId = group ? readNonEmptyString(group.activeProfileId) : null;
    if (!group || !activeProfileId) {
      const result = await params.consumer.consumeUnavailable({
        serviceId: currentSessions[0]!.serviceId,
        groupId: currentSessions[0]!.groupId,
        unavailableReason: group ? 'active_profile_missing' : 'group_missing',
        sessions: currentSessions.map((session) => ({
          sessionId: session.sessionId,
          activity: 'live',
          fromProfileId: session.fromProfileId,
          applicationOwnerId: session.applicationOwnerId,
          isCurrent: session.isCurrent,
        })),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!result.acknowledgeable) {
        throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
      }
      reconciledGroupCount += 1;
      sessionDispositionCount += currentSessions.length;
      continue;
    }
    const decisionCommittedTarget = {
      serviceId: group.serviceId,
      groupId: group.groupId,
      profileId: activeProfileId,
      generation: group.generation,
      credentialRevision: params.resolveCredentialRevision(group.serviceId, activeProfileId),
    } as const;
    const credentialBoundary = params.resolveCredentialBoundary?.(group.serviceId, activeProfileId)
      ?? (
        decisionCommittedTarget.credentialRevision === null
          ? { status: 'absent' as const }
          : {
              status: 'present' as const,
              revisionSemantics: 'revisioned' as const,
              credentialRevision: decisionCommittedTarget.credentialRevision,
            }
      );
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(decisionCommittedTarget),
      provenance: 'reconciliation',
      requestedTarget: { profileId: activeProfileId },
      decisionCommittedTarget,
    });
    const sessionsNeedingApply = currentSessions.filter((session) => {
      if (
        session.applicationSettledProfileId !== activeProfileId
        || session.applicationSettledGeneration !== group.generation
      ) return true;
      // A revisionless projection is not runner availability. Re-read/apply the selected
      // account through the owner, which obtains the server's current (also legacy-row) revision.
      return !(
        credentialBoundary.status === 'present'
        && credentialBoundary.revisionSemantics === 'revisioned'
        && session.applicationSettledCredentialRevision === credentialBoundary.credentialRevision
      );
    });
    const sessionsAlreadyApplied = currentSessions.filter((session) => !sessionsNeedingApply.includes(session));
    const sessionsRequiringCurrentTruthNotification = sessionsAlreadyApplied.filter(
      (session) => !session.applicationSettledBySpawnMaterialization,
    );
    const result = await params.consumer.consume({
      committedGeneration,
      switchReason: 'manual',
      executionAuthority: params.executionAuthority,
      sessions: sessionsNeedingApply.map((session) => ({
        sessionId: session.sessionId,
        activity: 'live',
        fromProfileId: session.fromProfileId,
        applicationOwnerId: session.applicationOwnerId,
        isCurrent: session.isCurrent,
      })),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!result.acknowledgeable) {
      throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
    }
    if (sessionsRequiringCurrentTruthNotification.length > 0) {
      if (credentialBoundary.status !== 'present' || credentialBoundary.revisionSemantics !== 'revisioned') {
        throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
      }
      const truthResult = await params.consumer.consumeAvailableCurrentTruth({
        serviceId: committedGeneration.decisionCommittedTarget.serviceId,
        groupId: committedGeneration.decisionCommittedTarget.groupId,
        generation: committedGeneration.decisionCommittedTarget.generation,
        credentialRevision: credentialBoundary.credentialRevision,
        sessions: sessionsRequiringCurrentTruthNotification.map((session) => ({
          sessionId: session.sessionId,
          activity: 'live',
          fromProfileId: session.fromProfileId,
          applicationOwnerId: session.applicationOwnerId,
          isCurrent: session.isCurrent,
        })),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!truthResult.acknowledgeable) {
        throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
      }
    }
    reconciledGroupCount += 1;
    sessionDispositionCount += sessionsNeedingApply.length;
  }
  return { acknowledgeable: true, reconciledGroupCount, sessionDispositionCount };
}

export async function reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget(params: Readonly<{
  target: ConnectedServiceGenerationRuntimeTarget;
  providerAdoptedTargets?: readonly ConnectedServiceProviderAdoptedGenerationTarget[];
  consumer: ConnectedServiceAuthGroupGenerationConsumer;
  listCurrentGroups: (serviceId: ConnectedServiceId) => Promise<readonly ConnectedServiceProjectedAuthGroup[]>;
  resolveCredentialRevision: (serviceId: ConnectedServiceId, profileId: string) => string | null;
  resolveCredentialBoundary: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => ConnectedServiceProjectedCredentialBoundary;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}>) {
  params.signal?.throwIfAborted();
  const adoptedByScope = new Map((params.providerAdoptedTargets ?? []).map((target) => [
    groupScopeKey(target),
    target,
  ] as const));
  const materializedByScope = new Map<string, ConnectedServiceAuthGroupGenerationTarget>();
  if (
    readNonEmptyString(params.target.agentId)
    && readNonEmptyString(params.target.connectedServiceMaterializationIdentityV1?.id)
  ) {
    for (const binding of params.target.activeBindings) {
      const groupId = readNonEmptyString(binding.groupId);
      if (!groupId || binding.generation === null) continue;
      materializedByScope.set(groupScopeKey({ serviceId: binding.serviceId, groupId }), {
        serviceId: binding.serviceId,
        groupId,
        profileId: binding.profileId,
        generation: binding.generation,
        credentialRevision: binding.credentialRevision ?? null,
      });
    }
  }
  return await reconcileKnownConnectedServiceAuthGroupScopes({
    scopes: listRuntimeSessionScopes([params.target], () => params.isCurrent?.() !== false).map((scope) => {
      // Provider-owned verification is stronger evidence, but an exact target that already came
      // through the successful materialization/spawn owner is sufficient application settlement.
      // Provider acceptance remains a separate later fact and is not required to avoid re-applying
      // the same credentials during passive registration reconciliation.
      const providerAdopted = adoptedByScope.get(groupScopeKey(scope));
      const spawnMaterialized = materializedByScope.get(groupScopeKey(scope));
      const settled = providerAdopted ?? spawnMaterialized ?? null;
      return settled ? {
        ...scope,
        applicationSettledProfileId: settled.profileId,
        applicationSettledGeneration: settled.generation,
        applicationSettledCredentialRevision: settled.credentialRevision,
        applicationSettledBySpawnMaterialization: (
          spawnMaterialized !== undefined
          && (providerAdopted === undefined || providerAdopted.credentialRevision === null)
          && !readNonEmptyString(params.target.brokerSelectionIdentity)
        ),
      } : scope;
    }),
    consumer: params.consumer,
    listCurrentGroups: params.listCurrentGroups,
    resolveCredentialRevision: params.resolveCredentialRevision,
    resolveCredentialBoundary: params.resolveCredentialBoundary,
    executionAuthority: params.executionAuthority,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
}

export async function reconcileConnectedServiceAuthGroupGenerations(params: Readonly<{
  consumer: ConnectedServiceAuthGroupGenerationConsumer;
  listCurrentGroups: (serviceId: ConnectedServiceId) => Promise<readonly ConnectedServiceProjectedAuthGroup[]>;
  resolveCredentialRevision: (serviceId: ConnectedServiceId, profileId: string) => string | null;
  listRuntimeTargets: () => readonly ConnectedServiceGenerationRuntimeTarget[];
  isCurrentRuntimeTarget?: (target: ConnectedServiceGenerationRuntimeTarget) => boolean;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  groupScopes?: readonly Readonly<{ serviceId: ConnectedServiceId; groupId: string }>[];
  signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  const allScopes = await listCurrentConnectedServiceAuthGroupSessionScopes({
    listRuntimeTargets: params.listRuntimeTargets,
    ...(params.isCurrentRuntimeTarget ? { isCurrentRuntimeTarget: params.isCurrentRuntimeTarget } : {}),
  });
  const allowedGroupScopes = params.groupScopes
    ? new Set(params.groupScopes.map(groupScopeKey))
    : null;
  const scopes = allowedGroupScopes
    ? allScopes.filter((scope) => allowedGroupScopes.has(groupScopeKey(scope)))
    : allScopes;
  params.signal?.throwIfAborted();
  return await reconcileKnownConnectedServiceAuthGroupScopes({
    scopes,
    consumer: params.consumer,
    listCurrentGroups: params.listCurrentGroups,
    resolveCredentialRevision: params.resolveCredentialRevision,
    executionAuthority: params.executionAuthority,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

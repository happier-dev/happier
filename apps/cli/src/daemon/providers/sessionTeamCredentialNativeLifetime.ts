import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { ManagedCredentialDeliveryResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { computeTeamCredentialNativeBindingReadDigestV1, type TeamCredentialNativeBindingReadResponseV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';

import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { dispatchOriginalAccountAction, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';
import type { SessionTeamCredentialNativeOpen } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { TrackedSession } from '@/daemon/types';
import type { SessionNativeCredentialLifetimeAccount } from '@/daemon/sessions/onChildExited';
import { projectTeamCredentialLaunchFailure, SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';
import { fetchTeamCredentialNativeBinding } from '../connectedServices/directMaterial/teamCredentialDirectMaterialHttp';

type NativeBinding = Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
export type DaemonSessionTeamCredentialNativeLifetime = Readonly<{
  machineId: string;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  homeServerIdentityId?: string;
  installationIdentity: Readonly<{ installationId: string; privateKey: ExternalActionMachineRequestSigningKey }> | null;
  resolveCurrentMachineExecutionOriginContext(signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null>;
}>;

/** The owning Session's captured Account survives requester/Run retirement;
 * the daemon's ambient Account never substitutes for a foreign owner. */
export function createDaemonSessionTeamCredentialNativeRelease(dependencies:
  Omit<DaemonSessionTeamCredentialNativeLifetime, 'installationIdentity'> & Readonly<{
    accountId: string;
    readInstallationIdentity(): DaemonSessionTeamCredentialNativeLifetime['installationIdentity'];
  }>): (sessionId: string, tracked: TrackedSession, lifetimeAccount?: SessionNativeCredentialLifetimeAccount) => Promise<boolean | void> {
  return async (sessionId, tracked, lifetimeAccount) => {
    const bindings = tracked.spawnOptions?.teamCredentialBindings ?? [];
    if (!bindings.some(binding => binding.resourceId !== null && binding.deliveryMode === 'vendor-native')) return;
    const attribution = tracked.requesterWorkAttributionV1 ?? tracked.spawnOptions?.requesterWorkAttributionV1;
    if (attribution && attribution.accountId !== dependencies.accountId && !lifetimeAccount
      || lifetimeAccount && (!lifetimeAccount.homeServerIdentityId
        || attribution && lifetimeAccount.accountId !== attribution.accountId)) throw new SessionTeamCredentialLaunchUnavailableError();
    return await releaseDaemonSessionTeamCredentialNativeBindings({ sessionId,
      owningAccountId: lifetimeAccount?.accountId ?? attribution?.accountId ?? dependencies.accountId, bindings }, {
      machineId: dependencies.machineId, credentials: lifetimeAccount?.credentials ?? dependencies.credentials,
      serverHttpBaseUrl: lifetimeAccount?.serverHttpBaseUrl ?? dependencies.serverHttpBaseUrl,
      ...(lifetimeAccount?.homeServerIdentityId ? { homeServerIdentityId: lifetimeAccount.homeServerIdentityId } : {}),
      installationIdentity: dependencies.readInstallationIdentity(),
      resolveCurrentMachineExecutionOriginContext: dependencies.resolveCurrentMachineExecutionOriginContext,
    });
  };
}

/** Read-only retained native model/placeholder access. A lifetime release uses
 * its captured owning Account, without any ended requester currentness. */
export async function readDaemonSessionTeamCredentialNativeBinding(input: Readonly<{
  sessionId: string;
  binding: NativeBinding;
  signal?: AbortSignal;
  providerSettingsOperationContext?: SavedSecretOperationContextV1;
}>, dependencies: DaemonSessionTeamCredentialNativeLifetime & Readonly<{ accountId: string }>): Promise<TeamCredentialNativeBindingReadResponseV1> {
  const unavailable = { status: 'unavailable', reason: 'binding_unavailable' } as const;
  input.signal?.throwIfAborted();
  const facet = input.binding.nativeDelivery;
  const identity = dependencies.installationIdentity;
  if (input.binding.deliveryMode !== 'vendor-native' || !input.binding.teamId || !facet || !identity
    || identity.installationId !== facet.guestInstallationId) return unavailable;
  const requester = input.providerSettingsOperationContext;
  const accountId = requester ? readAccountIdFromToken(requester.credentials.token) : dependencies.accountId;
  if (!accountId) return unavailable;
  const origin = await dependencies.resolveCurrentMachineExecutionOriginContext(input.signal);
  if (!origin || origin.machineId !== dependencies.machineId
    || dependencies.homeServerIdentityId !== undefined && origin.serverIdentityId !== dependencies.homeServerIdentityId) return unavailable;
  const request = { purpose: 'vendor_native_binding' as const, homeId: origin.serverIdentityId,
    teamId: input.binding.teamId, resourceId: input.binding.resourceId, sessionId: input.sessionId,
    managedId: facet.managedId, bindingKey: facet.bindingKey,
    expectedResourceRevision: input.binding.expectedResourceRevision,
    expectedSourceRevision: facet.sourceRevision, expectedProviderTicket: facet.providerTicket,
    machineId: dependencies.machineId, installationId: identity.installationId };
  const proof = signMachineInstallationProof({ payload: { version: 1, accountId,
    machineId: request.machineId, installationId: request.installationId,
    nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(request) } },
    privateKey: identity.privateKey });
  const result = await fetchTeamCredentialNativeBinding({ request: { ...request, proof }, signal: input.signal,
    token: requester?.credentials.token ?? dependencies.credentials.token,
    serverUrl: requester?.serverHttpBaseUrl ?? dependencies.serverHttpBaseUrl });
  return result;
}

/** Both admitted first use and terminal release enter the existing Action and
 * controller composer. This owner never materializes an inference key. */
async function applyBinding(input: Readonly<{
  sessionId: string; binding: NativeBinding; operation: 'install' | 'release';
  spawn?: Readonly<{ context: RpcActionExecutorContext; agentTargetKey: string; modelId: string }>;
  signal?: AbortSignal;
}>, dependencies: DaemonSessionTeamCredentialNativeLifetime): Promise<void> {
  const facet = input.binding.nativeDelivery;
  const installation = dependencies.installationIdentity;
  if (!facet || input.binding.deliveryMode !== 'vendor-native' || input.binding.slot.kind !== 'provider_model'
    || !installation || installation.installationId !== facet.guestInstallationId) throw new SessionTeamCredentialLaunchUnavailableError();
  const root = input.spawn?.context.externalActionExecutionAuthorization;
  const requester = root ? readRequesterAccountActionContext(root) : null;
  if (input.operation === 'install' && (!input.spawn || !root || !requester)) throw new SessionTeamCredentialLaunchUnavailableError();
  const credentials = requester?.credentials ?? dependencies.credentials;
  const serverHttpBaseUrl = requester?.serverHttpBaseUrl ?? dependencies.serverHttpBaseUrl;
  const origin = await dependencies.resolveCurrentMachineExecutionOriginContext(input.signal);
  if (!origin || origin.machineId !== dependencies.machineId
    || dependencies.homeServerIdentityId !== undefined && origin.serverIdentityId !== dependencies.homeServerIdentityId) throw new SessionTeamCredentialLaunchUnavailableError();
  const machine = await readManagedMachine({ credentials, serverHttpBaseUrl, homeId: origin.serverIdentityId,
    managedId: facet.managedId, ...(input.signal ? { signal: input.signal } : {}) });
  const controller = machine.controller;
  if (machine.enrolledMachineId !== dependencies.machineId || !controller || controller.installationId !== facet.controllerInstallationId) {
    throw new SessionTeamCredentialLaunchUnavailableError();
  }
  const result = await dispatchOriginalAccountAction({ actionId: 'machines.managed.credentials.install',
    input: { homeId: origin.serverIdentityId, managedId: facet.managedId, sessionId: input.sessionId,
      bindingKey: facet.bindingKey, expectedResourceRevision: input.binding.expectedResourceRevision,
      expectedSourceRevision: facet.sourceRevision, expectedProviderTicket: facet.providerTicket,
      ...(input.operation === 'release' ? { operation: 'release' } : {}) },
    requestId: randomUUID(), target: { kind: 'machine', machineId: controller.machineId },
    credentials, serverHttpBaseUrl, serverIdentityId: origin.serverIdentityId, authority: 'account_automation',
    ...(input.spawn ? { nativeCredentialSpawnChild: { context: input.spawn.context,
      machineId: dependencies.machineId, installationId: installation.installationId, privateKey: installation.privateKey,
      binding: input.binding, agentTargetKey: input.spawn.agentTargetKey, modelId: input.spawn.modelId } } : {}),
    ...(input.operation === 'install' && requester ? { isCurrent: requester.isCurrent } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!result.ok) throw projectTeamCredentialLaunchFailure(result, 'binding', 'team_credential_provider_selection_not_current');
  const delivery = ManagedCredentialDeliveryResultV1Schema.safeParse(result.result);
  if (!delivery.success || delivery.data.kind !== 'confirmed' || !isDeepStrictEqual(delivery.data.binding, facet)) {
    throw projectTeamCredentialLaunchFailure(delivery.success ? delivery.data : null, 'binding', 'team_credential_provider_selection_not_current');
  }
}

export async function installDaemonSessionTeamCredentialNativeBinding(
  input: Parameters<SessionTeamCredentialNativeOpen>[0] & Readonly<{ spawnActionContext?: RpcActionExecutorContext }>,
  dependencies: DaemonSessionTeamCredentialNativeLifetime,
): Promise<void> {
  if (input.consumer.kind !== 'session' || !input.spawnActionContext) throw new SessionTeamCredentialLaunchUnavailableError();
  await applyBinding({ sessionId: input.consumer.sessionId, binding: input.binding, operation: 'install', signal: input.signal,
    spawn: { context: input.spawnActionContext, agentTargetKey: input.agentTargetKey, modelId: input.modelId } }, dependencies);
}

/** Owning Session release carries no retained spawn/turn ingress. Failure keeps
 * terminal custody at its caller so current-state removal can be retried. Only
 * an actual confirmed removal may be retained across publication retry; a
 * prepared diagnostic is re-read on the next real lifetime trigger. */
export async function releaseDaemonSessionTeamCredentialNativeBindings(input: Readonly<{
  sessionId: string; owningAccountId: string; bindings: readonly SessionTeamCredentialBindingIntentV1[];
}>, dependencies: DaemonSessionTeamCredentialNativeLifetime): Promise<boolean> {
  if (!input.bindings.some(binding => binding.resourceId !== null && binding.deliveryMode === 'vendor-native')) return true;
  if (readAccountIdFromToken(dependencies.credentials.token) !== input.owningAccountId) throw new SessionTeamCredentialLaunchUnavailableError();
  let confirmedRemoval = true;
  for (const binding of input.bindings) {
    if (binding.resourceId === null || binding.deliveryMode !== 'vendor-native') continue;
    const current = await readDaemonSessionTeamCredentialNativeBinding({ sessionId: input.sessionId, binding },
      { ...dependencies, accountId: input.owningAccountId });
    if (current.status === 'prepared' && isDeepStrictEqual(current.binding, binding.nativeDelivery)) {
      confirmedRemoval = false;
      continue;
    }
    await applyBinding({ sessionId: input.sessionId, binding, operation: 'release' }, dependencies);
  }
  return confirmedRemoval;
}

import { isDeepStrictEqual } from 'node:util';
import type { SessionTeamCredentialNativeOpen } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import { assertSessionTeamCredentialNativeModel } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { installDaemonSessionTeamCredentialNativeBinding, readDaemonSessionTeamCredentialNativeBinding } from './sessionTeamCredentialNativeLifetime';
export { readDaemonSessionTeamCredentialNativeBinding } from './sessionTeamCredentialNativeLifetime';
import { join } from 'node:path';

import type { StoredCredentials } from '@/persistence';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { openTeamCredentialProviderBroker } from '@/api/client/providerBrokerApi';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  openSessionTeamCredentialProviderBinding,
  type SessionTeamCredentialDirectOpen,
  type SessionTeamCredentialProviderBinding,
} from '@/providers/broker/sessionTeamCredentialProviderBinding';
import {
  readSessionTeamCredentialProviderModels,
  SessionTeamCredentialLaunchUnavailableError,
} from '@/session/services/sessionTeamCredentialLaunch';
import { createProviderBrokerMachineCarrierTunnelOpen } from '../peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import type { DaemonMachineIrohRuntime } from '../peer/iroh/daemonMachineIrohRuntime';
import type { startDaemonSessionControlRuntime } from '../startup/startDaemonSessionControlRuntime';

type BindingOpen = NonNullable<Parameters<typeof startDaemonSessionControlRuntime>[0]['openTeamCredentialProviderBinding']>;
type BindingOpenInput = Parameters<BindingOpen>[0];

/** An installed Session/Run open borrows only local launch material. Actual
 * owning Session end is a separate awaited lifecycle Action, never PID cleanup. */
export function createDaemonSessionTeamCredentialNativeOpen(
  dependencies: Parameters<typeof readDaemonSessionTeamCredentialNativeBinding>[1] & Readonly<{
    spawnActionContext?: RpcActionExecutorContext;
    providerSettingsOperationContext?: SavedSecretOperationContextV1;
  }>,
): SessionTeamCredentialNativeOpen {
  return async input => {
    const sessionId = input.consumer.kind === 'session' ? input.consumer.sessionId : input.sessionId;
    if (!sessionId || input.sessionId && input.sessionId !== sessionId) throw new SessionTeamCredentialLaunchUnavailableError();
    const read = (signal = input.signal) => readDaemonSessionTeamCredentialNativeBinding({
      sessionId, binding: input.binding, signal, providerSettingsOperationContext: dependencies.providerSettingsOperationContext,
    }, dependencies);
    let accepted = await read();
    if (accepted.status === 'prepared' && isDeepStrictEqual(accepted.binding, input.binding.nativeDelivery)) {
      await installDaemonSessionTeamCredentialNativeBinding({ ...input, spawnActionContext: dependencies.spawnActionContext }, dependencies);
      accepted = await read();
    }
    if (accepted.status !== 'ready' || !isDeepStrictEqual(accepted.binding, input.binding.nativeDelivery)) {
      throw new SessionTeamCredentialLaunchUnavailableError();
    }
    assertSessionTeamCredentialNativeModel({ row: accepted.model, binding: input.binding,
      agentTargetKey: input.agentTargetKey, modelId: input.modelId });
    return Object.freeze({ model: accepted.model, endpoint: accepted.endpoint,
      credentialTransport: accepted.credentialTransport, placeholder: accepted.placeholder,
      async cleanup() {},
    });
  };
}

/** Composition used by both Session and independently selected Run bindings. */
export async function openDaemonSessionTeamCredentialProviderBinding(input: BindingOpenInput, dependencies: Readonly<{
  machineId: string;
  accountId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  credentials: StoredCredentials;
  happyHomeDir: string;
  controller: PluginReloadController;
  runtime?: DaemonMachineIrohRuntime | null;
  resolveTrustRoots: Parameters<typeof createProviderBrokerMachineCarrierTunnelOpen>[0]['resolveTrustRoots'];
  openTeamDirect: SessionTeamCredentialDirectOpen;
  openVendorNative?: SessionTeamCredentialNativeOpen;
}>): Promise<SessionTeamCredentialProviderBinding> {
  // The dispatcher supplies the admitted Session/Run Account. Changing only
  // its Home URL cannot change the daemon's captured bearer or tunnel identity.
  const requester = input.providerSettingsOperationContext;
  if (requester && !await requester.isCurrent(input.signal)) {
    throw new SessionTeamCredentialLaunchUnavailableError();
  }
  const accountId = requester ? readAccountIdFromToken(requester.credentials.token) : dependencies.accountId;
  if (!accountId) throw new SessionTeamCredentialLaunchUnavailableError();
  const credentials = requester?.credentials ?? dependencies.credentials;
  const serverHttpBaseUrl = requester?.serverHttpBaseUrl ?? dependencies.serverHttpBaseUrl;
  const homeDomainAction = createAccountServerActionDeps({ token: credentials.token, credentials,
    serverId: dependencies.serverId, serverHttpBaseUrl }).homeDomainAction;
  if (!homeDomainAction) throw new SessionTeamCredentialLaunchUnavailableError();
  const openTunnel = dependencies.runtime
    ? createProviderBrokerMachineCarrierTunnelOpen({ accountId,
        localMachineId: dependencies.machineId, runtime: dependencies.runtime,
        resolveTrustRoots: dependencies.resolveTrustRoots,
        beginSessionApplicationRequest: sessionId => sessionId === input.sessionId ? input.beginBrokerRequest?.() : undefined })
    : undefined;
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: dependencies.happyHomeDir, controller: dependencies.controller,
  });
  try {
    const opened = await openSessionTeamCredentialProviderBinding({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.consumer ? { consumer: input.consumer } : {}),
      machineId: dependencies.machineId, agentId: input.agentId,
      agentTargetKey: input.agentTargetKey, modelId: input.modelId,
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: input.resourceId,
        expectedResourceRevision: input.expectedResourceRevision,
        deliveryMode: input.deliveryMode, teamId: input.teamId,
        ...(input.nativeDelivery ? { nativeDelivery: input.nativeDelivery } : {}) },
      lease, materializationBaseDir: join(dependencies.happyHomeDir, 'providers', 'materialized'),
      signal: input.signal, providerSettingsOperationContext: input.providerSettingsOperationContext,
      readCatalog: signal => readSessionTeamCredentialProviderModels({
        homeDomainAction, lease, agentId: input.agentId,
        agentTargetKey: input.agentTargetKey, resourceId: input.resourceId, teamId: input.teamId, deliveryMode: input.deliveryMode, executionMachineId: dependencies.machineId, signal,
      }),
      ...(openTunnel ? { openBroker: (request, signal) => openTeamCredentialProviderBroker({
        token: credentials.token, serverBaseUrl: serverHttpBaseUrl, request, signal }), openTunnel } : {}),
      openTeamDirect: dependencies.openTeamDirect,
      ...(dependencies.openVendorNative ? { openVendorNative: dependencies.openVendorNative } : {}),
    });
    if (!opened) throw new SessionTeamCredentialLaunchUnavailableError();
    return opened;
  } finally { await lease.release(); }
}

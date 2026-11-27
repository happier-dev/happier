import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ExecutionRunTeamCredentialProviderBindingPreparer } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import type { StoredCredentials } from '@/persistence';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { ConnectedServiceCredentialHttpClient } from '@/api/client/connectedServiceCredentialApi';
import { openTeamCredentialProviderBroker } from '@/api/client/providerBrokerApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  openSessionTeamCredentialProviderBinding,
  type SessionTeamCredentialProviderBinding,
} from '@/providers/broker/sessionTeamCredentialProviderBinding';
import {
  readSessionTeamCredentialProviderModels,
  SessionTeamCredentialLaunchUnavailableError,
} from '@/session/services/sessionTeamCredentialLaunch';
import { createProviderBrokerMachineCarrierTunnelOpen } from '../peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import type { DaemonMachineIrohRuntime } from '../peer/iroh/daemonMachineIrohRuntime';
import type { SessionTeamCredentialNativeOpen } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import { assertSessionTeamCredentialNativeModel } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { startDaemonSessionControlRuntime } from '../startup/startDaemonSessionControlRuntime';
import { observeConnectedServiceMaterializationPhase, observeCurrentConnectedServiceMaterializationPhase as observePhase } from '../connectedServices/materialize/materializationPhase';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { installDaemonSessionTeamCredentialNativeBinding, readDaemonSessionTeamCredentialNativeBinding } from './sessionTeamCredentialNativeLifetime';
import { createRequesterTeamCredentialDirectMaterialClient } from '../connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createDaemonTeamCredentialDirectMaterialOpen } from './teamCredentialDirectMaterialComposition';
export { readDaemonSessionTeamCredentialNativeBinding } from './sessionTeamCredentialNativeLifetime';

type BindingOpen = NonNullable<Parameters<typeof startDaemonSessionControlRuntime>[0]['openTeamCredentialProviderBinding']>;
type BindingOpenInput = Parameters<BindingOpen>[0];

/** Give one detached Run its own Team binding lifetime. */
export function createDetachedRunTeamCredentialProviderBindingPreparer(
  openBinding: BindingOpen,
  readMachineId: () => string,
): ExecutionRunTeamCredentialProviderBindingPreparer {
  return async request => {
    const selection = request.selection;
    if (!selection) return null;
    if (!request.machineId || request.machineId !== readMachineId()) {
      throw new Error('team_credential_provider_machine_not_current');
    }
    const lifetime = new AbortController();
    const opened = await openBinding({
      teamId: selection.teamId,
      resourceId: selection.resourceId,
      expectedResourceRevision: selection.expectedResourceRevision,
      deliveryMode: selection.deliveryMode,
      agentId: request.agentId,
      agentTargetKey: selection.agentTargetKey,
      modelId: selection.modelId,
      consumer: { kind: 'execution_run', executionRunId: request.runId },
      ...(request.providerSettingsOperationContext
        ? { providerSettingsOperationContext: request.providerSettingsOperationContext } : {}),
      signal: lifetime.signal,
    });
    let closed = false;
    return Object.freeze({
      ...opened,
      async cleanup() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        await opened.cleanup();
      },
    });
  };
}

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
  openVendorNative?: SessionTeamCredentialNativeOpen;
}>): Promise<SessionTeamCredentialProviderBinding> {
  const consumer = input.consumer;
  return await observeConnectedServiceMaterializationPhase({ agentId: input.agentId,
    materializationKey: consumer?.kind === 'execution_run' ? consumer.executionRunId
      : consumer?.kind === 'session' ? consumer.sessionId : input.sessionId ?? '',
  }, 'credential_binding_resolution', async () => {
    // All Team binding requests use the admitted Session/Run Account and Home.
    const requester = input.providerSettingsOperationContext;
    if (requester && !await observePhase('established_account_currentness', () => requester.isCurrent(input.signal))) {
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
          beginSessionApplicationRequest: sessionId => sessionId === input.sessionId ? input.beginBrokerRequest?.() : undefined,
          observeSessionCarrierFailure: (sessionId, read) => { if (sessionId === input.sessionId) input.observeBrokerCarrierFailure?.(read); } })
      : undefined;
    const lease = await observePhase('runtime_registry', () => acquireAuthoritativePluginRuntimeRegistryLease({
      happyHomeDir: dependencies.happyHomeDir, controller: dependencies.controller,
    }));
    try {
      const opened = await observePhase('materialization_invoke', () => openSessionTeamCredentialProviderBinding({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.consumer ? { consumer: input.consumer } : {}),
        machineId: dependencies.machineId, agentId: input.agentId,
        agentTargetKey: input.agentTargetKey, modelId: input.modelId,
        binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: input.resourceId,
          expectedResourceRevision: input.expectedResourceRevision,
          deliveryMode: input.deliveryMode, teamId: input.teamId,
          ...(input.nativeDelivery ? { nativeDelivery: input.nativeDelivery } : {}) },
        lease, materializationBaseDir: join(dependencies.happyHomeDir, 'providers', 'materialized'),
        signal: input.signal,
        ...(input.exposeEndpoint ? { exposeEndpoint: input.exposeEndpoint } : {}),
        readCatalog: (signal, application) => observePhase('binding_read', () => readSessionTeamCredentialProviderModels({
          homeDomainAction, lease, agentId: input.agentId,
          agentTargetKey: input.agentTargetKey, resourceId: input.resourceId, teamId: input.teamId,
          executionMachineId: dependencies.machineId,
          deliveryMode: input.deliveryMode, signal, ...(application ? { application } : {}),
        })),
        ...(openTunnel ? { openBroker: (request, signal) => observePhase('launch_credentials', () => openTeamCredentialProviderBroker({
          token: credentials.token, serverBaseUrl: serverHttpBaseUrl, request, signal })), openTunnel } : {}),
        openTeamDirect: request => {
          const accountClient = new ConnectedServiceCredentialHttpClient(credentials);
          const directClient = createRequesterTeamCredentialDirectMaterialClient({
            credentials,
            serverHttpBaseUrl,
            readAccountEncryptionMode: signal => runWithServerHttpBaseUrl(serverHttpBaseUrl,
              () => accountClient.getAccountEncryptionMode({ signal })),
          });
          return createDaemonTeamCredentialDirectMaterialOpen({
            clientOpen: directClient.open, workerMachineId: dependencies.machineId, signal: input.signal,
          })(request);
        },
        ...(dependencies.openVendorNative ? { openVendorNative: dependencies.openVendorNative } : {}),
      }));
      if (!opened) throw new SessionTeamCredentialLaunchUnavailableError();
      return opened;
    } finally { await observePhase('established_registry_release', () => lease.release()); }
  });
}

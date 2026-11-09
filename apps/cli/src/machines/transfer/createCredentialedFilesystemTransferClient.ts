import { randomBytes } from 'node:crypto';
import { IrohNativeOperationError, MACHINE_ALPN, readIrohRelayConfigFromEnv } from '@happier-dev/iroh-native/node';
import { mintFiniteAccountClientTransferHandshake } from '@happier-dev/sync-client';
import { readMachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { FilesystemTransferActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { fetchAccountProfile } from '@/api/accountProfile';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { awaitMachineCarrierTunnelOpen, machineCarrierUnavailableError } from '@/daemon/peer/iroh/machineCarrier';
import { verifyDirectRouteGrantV2 } from '@/daemon/peer/mediation/verifyDirectRouteGrant';
import { assertDeploymentArchiveChildCurrentForHost } from '@/api/deploymentChildExecutionAuthorization';
import { createExternalActionAuthorizedRequestHeaders, type DeploymentArchiveOriginForHost,
  type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { verifyDeploymentArchiveOriginForHost } from '@/session/transport/rpc/machineRpc';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { createPreparedFilesystemTransferClient } from './preparedFilesystemTransferClient';

/** Captured installed custody for the existing byte driver, never Action input. */
export type DeploymentArchiveTransferAuthorityForHost = Readonly<{
  context: ActionExecutorContext; machineId: string; installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey; archiveOrigin: DeploymentArchiveOriginForHost;
  assertCurrent(): Promise<void>;
}>;

/** Finite CLI ingress: local custody, authenticated Home, and the same native carrier owner. */
export async function createCredentialedFilesystemTransferClient(input: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverIdentityId?: string;
  serverApiUrl: string;
  executeAction: (actionId: FilesystemTransferActionId | 'daemon.filesystem.copy' | 'action.operations.get', input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;
  signal?: AbortSignal;
  deploymentArchive?: DeploymentArchiveTransferAuthorityForHost;
}>) {
  const serverIdentityId = input.serverIdentityId ?? await resolveServerProfileHomeIdentityId(input.serverId);
  const [profile, features] = await runWithServerHttpBaseUrl(input.serverApiUrl, () => Promise.all([
    fetchAccountProfile({ token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) }),
    fetchServerFeaturesSnapshot({ serverUrl: input.serverApiUrl, token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) }),
  ]));
  if (features.status !== 'ready' || features.provenance !== 'authenticated') throw new Error('Authenticated finite transfer trust is unavailable');
  const trustRoots = features.features.capabilities.machines.peerMediation.grantSigningKeys;
  // The enclosing API also registers Actions that consume this transfer client.
  const { ApiClient } = await import('@/api/api');
  const api = await ApiClient.create(input.credentials);
  const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: configuration.happyHomeDir,
    identity: 'ephemeral', relayConfig: readIrohRelayConfigFromEnv(process.env) });
  if (!runtime.available) { await runtime.shutdown(); throw machineCarrierUnavailableError(); }
  const openMachineTunnel: Parameters<typeof createPreparedFilesystemTransferClient>[0]['openMachineTunnel'] = async request => {
      if (request.serverId && !areServerProfileIdentifiersEquivalent(input.serverId, request.serverId,
        identifier => identifier === input.serverId || identifier === serverIdentityId ? serverIdentityId ?? input.serverId : null)) throw new Error('server_scope_mismatch');
      const signal = input.signal && request.signal ? AbortSignal.any([input.signal, request.signal]) : request.signal ?? input.signal;
      const deployment = input.deploymentArchive;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        if (deployment) {
          await deployment.assertCurrent();
          await assertDeploymentArchiveChildCurrentForHost(deployment);
        }
        signal?.throwIfAborted();
      };
      await assertCurrent();
      const minted = await mintFiniteAccountClientTransferHandshake({ accountId: profile.id, machineId: request.targetMachineId,
        randomBytes: length => new Uint8Array(randomBytes(length)), signal,
        resolveInitiatorEndpointId: async () => runtime.endpoint.endpointId,
        readTargetEndpoint: async () => {
          if (deployment) {
            await assertCurrent();
            const target = await verifyDeploymentArchiveOriginForHost({ credentials: input.credentials,
              machineId: request.targetMachineId, serverUrl: input.serverApiUrl, signal,
              externalAction: { context: deployment.context, effectActionId: 'daemon.filesystem.download',
                installationId: deployment.installationId, privateKey: deployment.privateKey,
                deploymentArchiveOrigin: deployment.archiveOrigin } });
            await assertCurrent();
            if (!target.endpoint) return null;
            const { revision: _projectionRevision, ...endpoint } = target.endpoint;
            return endpoint;
          }
          const machines = await listCurrentAccountMachines({ token: input.credentials.token, serverHttpBaseUrl: input.serverApiUrl,
            ...(request.signal ? { signal: request.signal } : {}) });
          const machine = machines.find(row => row.id === request.targetMachineId);
          if (!machine?.active || machine.revokedAt !== null || machine.replacedByMachineId !== null || (machine.access && machine.access.accessState !== 'ready')) return null;
          const endpoint = readMachineIrohEndpointAuthorityV1({ capabilities: machine.operationProtocolCapabilities,
            revision: machine.operationProtocolCapabilitiesRevision });
          if (!endpoint) return null;
          return { endpointId: endpoint.endpointId,
            ...(endpoint.relayUrls ? { relayUrls: [...endpoint.relayUrls] } : {}),
            ...(endpoint.directAddresses ? { directAddresses: [...endpoint.directAddresses] } : {}) };
        },
        requestGrant: async grantRequest => {
          await assertCurrent();
          let authorizationHeaders: Readonly<Record<string, string>> | undefined;
          if (deployment) {
            const admitted = await assertDeploymentArchiveChildCurrentForHost(deployment);
            const authorization = deployment.context.externalActionExecutionAuthorization;
            if (!authorization) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
            authorizationHeaders = createExternalActionAuthorizedRequestHeaders({ authorization,
              effectActionId: authorization.binding.actionId, target: authorization.binding.target,
              installationId: deployment.installationId, privateKey: deployment.privateKey,
              deploymentChildExecution: admitted.execution, deploymentArchiveOrigin: deployment.archiveOrigin,
              method: 'POST', path: '/v1/machines/peer/mediation/route-grants', body: grantRequest });
          }
          const grant = await runWithServerHttpBaseUrl(input.serverApiUrl, () => api.mintPeerMediationRouteGrant(grantRequest,
            { ...(signal ? { signal } : {}), ...(authorizationHeaders ? { authorizationHeaders } : {}) }));
          await assertCurrent();
          return grant;
        },
      });
      const handshake = minted.handshake;
      const verified = verifyDirectRouteGrantV2({ grant: handshake.grant, proof: handshake.proof, trustRoots, nowMs: Date.now(),
        expected: { accountId: profile.id, machineId: request.targetMachineId, flowKind: 'bounded_transfer', routeKind: 'iroh_peer',
          endpointFingerprint: minted.endpoint.endpointId, iroh: { initiator: handshake.initiator, target: handshake.target, operationKind: 'finite_transfer' } } });
      if (!verified.valid) throw new Error(verified.reasonCode);
      await assertCurrent();
      const tunnel = await awaitMachineCarrierTunnelOpen(runtime.openTunnel({ alpn: MACHINE_ALPN, flow: 'finite_transfer',
        remoteEndpointId: minted.endpoint.endpointId, handshake }, minted.endpoint), signal).catch((error: unknown) => {
          signal?.throwIfAborted();
          if (error instanceof IrohNativeOperationError && error.nativeCode === 'transport-unavailable') {
            throw machineCarrierUnavailableError();
          }
          throw error;
        });
      try { await assertCurrent(); } catch (error) { await tunnel.close(); throw error; }
      if (tunnel.remoteEndpointId !== minted.endpoint.endpointId) { await tunnel.close(); throw new Error('transport_identity_mismatch'); }
      return tunnel;
    };
  const client = createPreparedFilesystemTransferClient({ executeAction: input.executeAction, openMachineTunnel });
  return { client, openMachineTunnel, close: runtime.shutdown };
}

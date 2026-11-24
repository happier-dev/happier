import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/rpc/socket';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { createOnHappySessionWebhook } from '@/daemon/sessions/onHappySessionWebhook';
import type {
  SessionTrackingKey,
  TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import type { TrackedSession } from '@/daemon/types';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createSkillStore } from '@/prompts/skills/store/skillStore';

type DaemonParams = Parameters<typeof startDaemonSessionControlRuntime>[0];

/**
 * A second installed daemon for another Machine of the same Home, so a root a
 * Session's source daemon delivers over Machine RPC reaches a real controller.
 *
 * The Home Machine-RPC relay is the boundary: `deliver` takes the source's
 * socket CALL packet and hands the receiving Machine socket what Home forwards
 * for an admitted Session-origin CALL (registerSocketRpcHandlers → forwardRpcCall):
 * the Home Machine admission, the caller's Session origin, the signed root as
 * `callerInputAuthorization` and the caller's authenticated authority. Home's own
 * admission and signature checks are not re-run here. Below the socket the
 * owner's Machine RPC registration, ingress owner and Action executor are real.
 *
 * One process holds one Installation identity and one stored-credential
 * profile per server, so the receiving controller shares both with the source
 * fixture: give its Machine row the fixture's Installation id.
 */
export async function createReceivingControllerDaemon(
  input: Readonly<{
    machineId: string;
    custodianAccountId: string;
    credentials: StoredCredentials;
    serverId: string;
    serverBaseUrl: string;
    homeServerIdentityId: string;
    installationId: string;
    happyHomeDir: string;
    pluginRuntimeController: PluginReloadController;
    resolveServerFeaturesSnapshot?: DaemonParams['resolveServerFeaturesSnapshot'];
  }>,
) {
  const machine = new ApiMachineClient(
    input.credentials.token,
    {
      id: input.machineId,
      encryptionMode: 'plain',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    },
    undefined,
    { resolveCurrentServerIdentityId: () => input.homeServerIdentityId },
  );
  onTestFinished(() => machine.shutdown());
  const trackedSessionsByKey: TrackedSessionMap = new Map();
  const spawnAwaiterByKey = new Map<
    SessionTrackingKey,
    (tracked: TrackedSession) => void
  >();
  const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({
    path: join(
      input.happyHomeDir,
      `controller-device-secret-${input.machineId}`,
    ),
  });
  const daemon = await startDaemonSessionControlRuntime({
    machineId: input.machineId,
    serverId: input.serverId,
    serverBaseUrl: input.serverBaseUrl,
    skillStore: createSkillStore({ happyHomeDir: input.happyHomeDir }),
    resolveCurrentMachineExecutionOriginContext: async () => ({
      serverIdentityId: input.homeServerIdentityId,
      machineId: input.machineId,
    }),
    ...(input.resolveServerFeaturesSnapshot
      ? { resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot }
      : {}),
    externalActionAccountId: input.custodianAccountId,
    credentials: input.credentials,
    api: {} as never,
    deviceLocalSecretStorage,
    pluginRuntimeController: input.pluginRuntimeController,
    connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
    daemonSessionMutationCustody: {
      stageTranscriptMessage: async () => {
        throw new Error('No transcript mutation');
      },
      stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
    },
    connectedServicesMaterializationBaseDir: join(
      input.happyHomeDir,
      `controller-connected-services-${input.machineId}`,
    ),
    getConnectedServiceRefreshCoordinator: () => null,
    getConnectedServiceQuotasCoordinator: () => null,
    trackedSessionsByKey,
    spawnAwaiterByKey,
    spawnResultResolverByKey: new Map(),
    spawnWebhookTimeoutByKey: new Map(),
    getApiMachineForSessions: () => machine,
    spawnResourceCleanupByKey: new Map(),
    sessionAttachCleanupByKey: new Map(),
    // The controller runs no Sessions of its own in these cases.
    resolveRequesterSessionRuntimeContext: async () => null,
    releaseRequesterSessionRuntimeContext: async () => {},
    connectedServicesRestartRequestedSessions: new Set(),
    beforeShutdown: async () => {},
    onHappySessionWebhook: createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      deviceLocalSecretStorage,
    }),
    requestShutdown() {},
    processEnv: { NODE_ENV: 'test' },
  });
  onTestFinished(() => daemon.stopControlServer());
  // The daemon's own Machine RPC registration, as installed daemon startup binds it.
  machine.setRPCHandlers(
    {
      spawnSession: daemon.spawnSession,
      stopSession: daemon.stopSession,
      requestShutdown() {},
    },
    {
      ...(daemon.externalActionIngressOwner
        ? { externalActionIngressOwner: daemon.externalActionIngressOwner }
        : {}),
    },
  );
  const manager: unknown = Reflect.get(machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager))
    throw new Error('Missing receiving controller Machine RPC manager');
  const received: RpcRequest[] = [];
  return {
    machine,
    daemon,
    manager,
    received,
    /** Home forwards one admitted CALL from another Machine's Session to this Machine. */
    async deliver(
      packet: SocketRpcRequestPayload,
      caller: Readonly<{
        actorAccountId: string;
        role: SocketRpcMachineAdmissionContextV1['role'];
      }>,
    ): Promise<unknown> {
      const authorization = packet.externalActionExecution?.authorization;
      const machineAdmission: SocketRpcMachineAdmissionContextV1 = {
        actorAccountId: caller.actorAccountId,
        custodianAccountId: input.custodianAccountId,
        machineId: input.machineId,
        installationId: input.installationId,
        role: caller.role,
        encryptionMode: 'plain',
      };
      const request: RpcRequest = {
        method: packet.method,
        params: packet.params,
        ...(packet.requestId ? { requestId: packet.requestId } : {}),
        machineAdmission,
        ...(authorization
          ? {
              // Home stamps the authenticated caller's authority and the root's Session origin.
              callerAuthority:
                authorization.binding.authentication.kind === 'terminal'
                  ? 'account_automation'
                  : 'present_user',
              ...(authorization.binding.sessionActionOrigin
                ? {
                    sessionActionOrigin:
                      authorization.binding.sessionActionOrigin,
                  }
                : {}),
              callerInputAuthorization: authorization,
            }
          : {}),
        ...(packet.originalActionEnvelope
          ? { originalActionEnvelope: packet.originalActionEnvelope }
          : {}),
      };
      received.push(request);
      return await manager.handleRequest(
        request,
        undefined,
        'authenticated_home_socket',
      );
    },
  };
}

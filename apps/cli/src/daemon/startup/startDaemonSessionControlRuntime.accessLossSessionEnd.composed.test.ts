import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import { readOrCreateInstallationIdentity } from '../identity/store';
import { registerMachineAccessLossReceiver } from '../externalActions/registerMachineAccessLossReceiver';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import {
  legacyPidSessionTrackingKey,
  type SessionTrackingKey,
} from '@/daemon/sessions/sessionTrackingKey';

afterEach(() => vi.restoreAllMocks());

const idle: SessionInputLiveWork = {
  session: 'settled',
  input: 'settled',
  agents: 'settled',
  attention: 'settled',
  settledAt: 1,
};
const working: SessionInputLiveWork = {
  ...idle,
  session: 'active',
  input: 'active',
};

/**
 * The installed daemon's own composition: the receiver options this runtime publishes,
 * its live-work producer fed by the runner's control push, and its ordinary Stop. Home
 * HTTP and the runner process are the boundaries. Once a grant is withdrawn the Home
 * no longer lends the guest's requester authority, so its resolver answers null.
 */
it.each(['idle', 'running'] as const)(
  'ends a withdrawn guest Session (%s) without the guest authority the withdrawal removed',
  async (turn) => {
    await withConfiguredDaemonTestHome(
      { prefix: 'access-loss-session-end-' },
      async ({ homeDir }) => {
        const sessions = new Map<SessionTrackingKey, TrackedSession>();
        const credentials = {
          token: 'fixture-owner',
          encryption: null,
        } satisfies StoredCredentials;
        const custody = createDaemonSessionMutationCustody({ credentials });
        const installation = await readOrCreateInstallationIdentity();
        const sessionId = 'guest-session';
        let raw: ReturnType<typeof createSessionRecordFixture> | undefined;
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
          const path = new URL(String(url)).pathname;
          if (path.includes('/v2/sessions/') && raw)
            return { status: 200, data: { session: raw } };
          if (path.endsWith('/encryption/currentness'))
            return {
              status: 200,
              data: {
                mode: 'plain',
                version: 1,
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                updatedAt: 1,
              },
            };
          throw new Error(`Unexpected Home read ${path}`);
        });
        vi.spyOn(axios, 'patch').mockImplementation(async () => {
          throw new Error('Unexpected Home write');
        });
        let receiverOptions:
          | Parameters<
              NonNullable<
                Parameters<
                  typeof startDaemonSessionControlRuntime
                >[0]['onMachineAccessLossReceiverReady']
              >
            >[0]
          | undefined;
        const runtime = await startDaemonSessionControlRuntime({
          machineId: 'machine',
          serverId: configuration.activeServerId,
          serverBaseUrl: configuration.apiServerUrl,
          externalActionAccountId: 'owner',
          credentials,
          api: {} as never,
          daemonSessionMutationCustody: custody,
          connectedServicesMaterializationBaseDir: join(
            homeDir,
            'connected-services',
          ),
          getConnectedServiceRefreshCoordinator: () => null,
          getConnectedServiceQuotasCoordinator: () => null,
          trackedSessionsByKey: sessions,
          spawnAwaiterByKey: new Map(),
          spawnResultResolverByKey: new Map(),
          spawnWebhookTimeoutByKey: new Map(),
          getApiMachineForSessions: () => null,
          spawnResourceCleanupByKey: new Map(),
          sessionAttachCleanupByKey: new Map(),
          connectedServicesRestartRequestedSessions: new Set(),
          startupTerminalRecovery: {
            disconnectedTerminalHostCandidates: [],
            unresolvedTerminalHostSessionIds: [],
          },
          beforeShutdown: async () => {},
          onHappySessionWebhook: async () => {},
          requestShutdown: () => {},
          resolveRequesterSessionRuntimeContext: async () => null,
          releaseRequesterSessionRuntimeContext: async (context) => {
            await context.dispose();
          },
          onMachineAccessLossReceiverReady: (options) => {
            receiverOptions = options;
          },
          processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '0' },
        });
        const rpc = new RpcHandlerManager({
          scopePrefix: 'machine',
          encryptionMode: 'plain',
          logger: () => {},
          authorizeRequest: (request) =>
            authorizeMachineRpcRequest(request, {
              machineId: 'machine',
              resolveCustodianAccountId: async () => 'owner',
              resolveInstallationId: () => installation.installationId,
              verifyMachineAdmission: async () => true,
            }),
        });
        if (!receiverOptions)
          throw new Error('Runtime did not publish its access-loss receiver');
        registerMachineAccessLossReceiver(rpc, {
          ...receiverOptions,
          machineId: 'machine',
        });
        const child = spawn(
          process.execPath,
          ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
        );
        const exited = once(child, 'exit');
        let revision = 0;
        const push = async (activity: SessionInputLiveWork) => {
          const response = await fetch(
            `http://127.0.0.1:${runtime.controlPort}/session-activity-changed`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-happier-daemon-token': runtime.controlToken,
              },
              body: JSON.stringify({
                sessionId,
                liveWork: {
                  runnerPid: child.pid,
                  revision: ++revision,
                  activity,
                },
              }),
            },
          );
          expect(response.status).toBe(200);
        };
        try {
          await once(child, 'message');
          const pid = child.pid!;
          const identity = await readProcessIdentityByPid(pid);
          if (!identity) throw new Error('Missing process fixture identity');
          raw = createSessionRecordFixture({
            id: sessionId,
            encryptionMode: 'plain',
            metadataLayoutVersion: 0,
            metadataVersion: 1,
            metadata: JSON.stringify({ machineId: 'machine', path: homeDir }),
          });
          const tracked: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(pid),
            pid,
            childProcess: child,
            happySessionId: sessionId,
            startedBy: 'daemon',
            processStartTimeMs: identity.processStartTimeMs,
            processCommandHash: hashProcessCommand(identity.command),
            requesterWorkAttributionV1: {
              accountId: 'guest',
              serverId: configuration.activeServerId,
              machineId: 'machine',
              installationId: installation.installationId,
            },
            spawnOptions: { directory: homeDir },
          };
          sessions.set(tracked.trackingKey, tracked);
          await writeSessionMarker({
            trackingKey: tracked.trackingKey,
            pid,
            happySessionId: sessionId,
            startedBy: 'daemon',
            processStartTimeMs: identity.processStartTimeMs,
            processCommandHash: hashProcessCommand(identity.command),
          });
          await push(turn === 'idle' ? idle : working);
          const withdrawal = rpc.handleRequest({
            method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
            authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
            params: { v: 1, subjectAccountId: 'guest' },
            machineAdmission: {
              actorAccountId: 'owner',
              custodianAccountId: 'owner',
              role: 'manage',
              machineId: 'machine',
              installationId: installation.installationId,
              encryptionMode: 'plain',
            },
          });
          if (turn === 'running') {
            await pause(300);
            // Admitted work finishes: the runner is still alive while its turn runs.
            expect(child.exitCode === null && child.signalCode === null).toBe(
              true,
            );
            await push(idle);
          }
          expect(
            await Promise.race([
              withdrawal,
              pause(8000).then(() => 'no answer'),
            ]),
          ).toEqual({ kind: 'settled' });
          expect(sessions.size).toBe(0);
          await exited;
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
          await exited;
          sessions.clear();
          await runtime.stopControlServer();
          await custody.close();
        }
      },
    );
  },
  20_000,
);

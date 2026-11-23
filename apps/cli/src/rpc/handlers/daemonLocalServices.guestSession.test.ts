import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServicePreviewRegistry } from '@/daemon/local/services/preview/registry';
import { createLocalServiceLauncherFeed } from '@/daemon/local/services/launch/feed';
import { createLocalServiceLauncherRoutes } from '@/daemon/local/services/launch/routes';
import { createRequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import type { RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { TrackedSession } from '@/daemon/types';
import { registerDaemonLocalServicesMachineRpcHandlers } from './daemonLocalServices';

const attribution = (accountId: string) => ({
  serverId: 'home-a',
  accountId,
  machineId: 'machine_1',
  installationId: 'installation_1',
});

/**
 * The Services ingress admission for a guest on another person's Machine (owner ruling 2026-11-23,
 * "A guest with Use on a shared Machine can start Services there"). Real: the RPC manager, the
 * Machine RPC authorizer, the Services registrations and Machine core's Session custody owner.
 * Replaced: Home's admission-currentness answer and the retained Session-birth resolver (the cold
 * custody store), which returns the context the daemon already holds for a tracked Session.
 */
describe("Services ingress admission of a guest's own Session", () => {
  const setup = () => {
    const guestSession: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(4101),
      pid: 4101,
      startedBy: 'daemon',
      happySessionId: 'guest-session',
      requesterWorkAttributionV1: attribution('guest'),
    };
    const releases: string[] = [];
    const sessionAccounts = createRequesterSessionAccountContextCustody({
      trackedSessions: new Map([[guestSession.trackingKey, guestSession]]),
      // The held context carries only the bootstrap facts this admission reads.
      resolveRequesterSessionRuntimeContext: async (sessionId, retained) =>
        sessionId === 'guest-session' && retained
          ? ({
              bootstrap: {
                attribution: retained,
                credentials: {
                  token: 'guest-session-bearer',
                  encryption: null,
                },
              },
            } as unknown as RequesterSessionRuntimeContext)
          : null,
      releaseRequesterSessionRuntimeContext: async (context) => {
        releases.push(context.bootstrap.attribution.accountId);
      },
      externalActionAccountId: 'custodian',
      serverId: 'home-a',
      machineId: 'machine_1',
      isRetired: () => false,
    });
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1',
      localMachineId: 'machine_1',
      encryptionMode: 'plain',
      logger: () => {},
      authorizeRequest: (request) =>
        authorizeMachineRpcRequest(request, {
          machineId: 'machine_1',
          resolveCustodianAccountId: async () => 'custodian',
          resolveInstallationId: () => 'installation_1',
          verifyMachineAdmission: async () => true,
        }),
    });
    const seen: (RpcHandlerContext['requesterSessionBootstrap'] | null)[] = [];
    const feed = createLocalServiceLauncherFeed({
      machineId: 'machine_1',
      inventoryRegistry: createLocalServiceInventoryRegistry(),
      previewRegistry: createLocalServicePreviewRegistry(),
    });
    registerDaemonLocalServicesMachineRpcHandlers(rpc, {
      machineId: 'machine_1',
      serverId: 'home-a',
      accountId: 'custodian',
      sessionAccounts,
      localServicesLauncher: createLocalServiceLauncherRoutes({
        feed,
        resolveStartTarget: async () =>
          ({ ok: false, reasonCode: 'launcher_target_unknown' }) as const,
      }),
      resolveLauncherActionExecutor: ({ ingress }) => ({
        execute: async () => {
          seen.push(ingress?.requesterSessionBootstrap ?? null);
          return {
            ok: false,
            errorCode: 'fixture_stop',
            error: 'fixture_stop',
          };
        },
      }),
    });
    const start = (
      actorAccountId: string,
      role: 'use' | 'manage',
      sessionId?: string,
    ) =>
      rpc.handleRequest({
        method: `machine_1:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START}`,
        params: createTargetedActionRpcRequestV1(
          {
            machineId: 'machine_1',
            targetId: 'declared-worker',
            ...(sessionId ? { sessionId } : {}),
          },
          { kind: 'machine', machineId: 'machine_1' },
        ),
        machineAdmission: {
          actorAccountId,
          custodianAccountId: 'custodian',
          machineId: 'machine_1',
          installationId: 'installation_1',
          role,
          encryptionMode: 'plain',
        },
      });
    return { start, seen, releases };
  };

  it.each(['use', 'manage'] as const)(
    "lends a %s guest their own Session's custody once and releases it",
    async (role) => {
      const { start, seen, releases } = setup();
      await start('guest', role, 'guest-session');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.attribution.accountId).toBe('guest');
      expect(releases).toEqual(['guest']);
    },
  );

  it("lends nothing for another person's Session, no Session, or the Machine owner", async () => {
    const { start, seen } = setup();
    await start('someone-else', 'manage', 'guest-session');
    await start('guest', 'use');
    await start('custodian', 'manage', 'guest-session');
    expect(seen).toEqual([null, null, null]);
  });
});

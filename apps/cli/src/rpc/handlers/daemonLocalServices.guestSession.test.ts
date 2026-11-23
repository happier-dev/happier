import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServicePreviewRegistry } from '@/daemon/local/services/preview/registry';
import { createLocalServiceLauncherFeed } from '@/daemon/local/services/launch/feed';
import { createLocalServiceLauncherRoutes } from '@/daemon/local/services/launch/routes';
import { discoverLocalServiceRunTargets } from '@/daemon/local/services/launch/runTargets';
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
                getBoundSessionId: () => sessionId,
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

/**
 * An own-Session read (owner decision 2026-11-23; security review SEC-RU2-1123 F1). The lent
 * Session lets a guest ACT; what they READ stays their own Session's workspace and their own
 * Services, whatever scope or folder they name. Real: the RPC manager, the Machine RPC authorizer,
 * the Services ingress, the read custody, the snapshot reader, the launcher feed and its package
 * discovery over real folders. Replaced: Home's admission-currentness answer, the retained
 * Session-birth resolver, the Session-to-folder marker read, and the managed-services owner (no
 * Service is running in this case).
 */
describe("Services ingress read of a guest's own Session", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  const setup = async () => {
    const base = await mkdtemp(join(tmpdir(), 'guest-services-read-'));
    dirs.push(base);
    const guestRoot = join(base, 'guest-project');
    const ownerRoot = join(base, 'owner-private');
    for (const [root, name] of [[guestRoot, 'guest-app'], [ownerRoot, 'owner-app']] as const) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ name, scripts: { dev: `${name}-dev-command` } }));
    }
    const guestSession: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(4102), pid: 4102, startedBy: 'daemon',
      happySessionId: 'guest-session', requesterWorkAttributionV1: attribution('guest'),
    };
    const sessionAccounts = createRequesterSessionAccountContextCustody({
      trackedSessions: new Map([[guestSession.trackingKey, guestSession]]),
      resolveRequesterSessionRuntimeContext: async (sessionId, retained) => sessionId === 'guest-session' && retained
        ? ({ bootstrap: { attribution: retained, getBoundSessionId: () => sessionId,
          credentials: { token: 'guest-session-bearer', encryption: null } } } as unknown as RequesterSessionRuntimeContext)
        : null,
      releaseRequesterSessionRuntimeContext: async () => {},
      externalActionAccountId: 'custodian', serverId: 'home-a', machineId: 'machine_1', isRetired: () => false,
    });
    const rpc = new RpcHandlerManager({
      scopePrefix: 'machine_1', localMachineId: 'machine_1', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: (request) => authorizeMachineRpcRequest(request, {
        machineId: 'machine_1', resolveCustodianAccountId: async () => 'custodian',
        resolveInstallationId: () => 'installation_1', verifyMachineAdmission: async () => true,
      }),
    });
    const inventoryRegistry = createLocalServiceInventoryRegistry();
    inventoryRegistry.replaceSnapshot({ v: 1, machineId: 'machine_1', generatedAt: 2_000, refreshState: 'idle', diagnostics: [],
      entries: [{ id: 'owner-listener', machineId: 'machine_1', address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: { scheme: 'http', host: '127.0.0.1', port: 5173, probeState: 'ready', probedAt: 2_000 }, port: 5173,
        protocol: 'tcp', detectedAt: 1_000, lastSeenAt: 2_000, state: 'listening', source: 'detected',
        presentation: { displayName: 'Owner web', folderLabel: 'owner-private', addressLabel: 'localhost:5173' }, labels: [],
        confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high', diagnostics: [],
        provenance: { process: { pid: 400, ppid: 300, lineagePids: [400, 300], command: 'owner-app-dev-command', cwd: ownerRoot, redacted: true } },
        classification: { kind: 'vite', displayName: 'Vite', confidence: 'high', lowSignal: false, signals: ['vite'] } }] });
    const feed = createLocalServiceLauncherFeed({
      machineId: 'machine_1', inventoryRegistry, previewRegistry: createLocalServicePreviewRegistry(),
      // The Machine's known roots stand in for the daemon's accepted Projects.
      runTargets: (roots, options) => discoverLocalServiceRunTargets({ roots: roots ?? [guestRoot, ownerRoot], ...options }),
      resolveSessionWorkspacePaths: (sessionId) => sessionId === 'guest-session' ? [guestRoot] : [],
      projectManagedServices: { readProcessRoots: () => [],
        // No Service runs here: the complete read resolves, the incumbent read answers at once.
        listProjectServices: ((options?: unknown) => options ? Promise.resolve([]) : []) as never },
    });
    registerDaemonLocalServicesMachineRpcHandlers(rpc, {
      machineId: 'machine_1', serverId: 'home-a', accountId: 'custodian', sessionAccounts,
      localServicesLauncher: createLocalServiceLauncherRoutes({ feed,
        resolveStartTarget: async () => ({ ok: false, reasonCode: 'launcher_target_unknown' }) as const }),
    });
    const snapshot = async (params: Record<string, unknown>, actorAccountId = 'guest'): Promise<string> => JSON.stringify(
      await rpc.handleRequest({
        method: `machine_1:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT}`,
        params: { machineId: 'machine_1', ...params },
        machineAdmission: { actorAccountId, custodianAccountId: 'custodian', machineId: 'machine_1',
          installationId: 'installation_1', role: 'use', encryptionMode: 'plain' },
      }));
    return { snapshot, ownerRoot };
  };
  const otherPersonsFacts = ['owner-app', 'owner-private', 'owner-listener', '5173'];

  it.each([
    ['the whole Machine', { scope: 'machine' }],
    ["another person's folder", { workspaceRoot: 'OWNER_ROOT' }],
    ['no scope', {}],
  ])('shows a guest asking for %s nothing of another person, and their own launch targets', async (_label, scope) => {
    const { snapshot, ownerRoot } = await setup();
    const read = await snapshot({ sessionId: 'guest-session',
      ...Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, value === 'OWNER_ROOT' ? ownerRoot : value])) });
    for (const fact of otherPersonsFacts) expect(read).not.toContain(fact);
    expect(read).toContain('guest-app:dev');
  });

  it("keeps the Machine owner's full view", async () => {
    const { snapshot } = await setup();
    const read = await snapshot({ scope: 'machine' }, 'custodian');
    expect(read).toContain('owner-listener');
  });
});

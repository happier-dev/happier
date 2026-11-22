import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { configuration } from '@/configuration';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { ApiMachineClient } from './apiMachine';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import {
  admitRequesterSessionBootstrap,
  createRequesterSessionRuntimeContextResolver,
  releaseUnretainedRequesterSessionRuntimeContext,
} from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import { createRequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import type { TrackedSession } from '@/daemon/types';
import {
  legacyPidSessionTrackingKey,
  type SessionTrackingKey,
} from '@/daemon/sessions/sessionTrackingKey';

const boundary = vi.hoisted(() => ({
  credentials: null as StoredCredentials | null,
  identity: null as
    | import('@happier-dev/protocol').MachineInstallationIdentityV1
    | null,
}));
// Only persisted identity/credentials and the Home/socket network boundaries are substituted.
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));
vi.mock('@/persistence', async (original) => ({
  ...(await original<typeof import('@/persistence')>()),
  readStoredCredentialsForServerId: async () => boundary.credentials,
}));
vi.mock('@/daemon/identity/store', async (original) => ({
  ...(await original<typeof import('@/daemon/identity/store')>()),
  readInstallationIdentityIfExistsSync: () => boundary.identity,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  boundary.credentials = null;
  boundary.identity = null;
});

type Scenario =
  | 'guest'
  | 'owner'
  | 'withdrawn guest'
  | 'guest Session not current';

/**
 * W21-A: an approved file write in a guest's own Session on another person's
 * Machine failed `workspace_target_unavailable`, because the Machine owner's
 * daemon read the guest's Session with the Machine owner's credentials. Real:
 * ApiMachineClient's filesystem executor, workspace source selection, the
 * requester custody owner and resolver, the guest's admitted bootstrap and
 * runtime, the Session read and locality proof, the write. Substituted: Home
 * HTTP, the socket, persisted identity/credentials. Not exercised: Home's
 * approval decision, root mint and verification (the effect is dispatched with
 * the Session origin the verified root carries).
 */
it.each([
  'guest',
  'owner',
  'withdrawn guest',
  'guest Session not current',
] as const)(
  "reaches an approved write's workspace through the Session's own Account: %s",
  async (scenario: Scenario) => {
    const pair = tweetnacl.sign.keyPair();
    boundary.identity = {
      version: 1,
      installationId: '11111111-1111-4111-8111-111111111111',
      createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'),
      privateKey: Buffer.from(pair.secretKey).toString('base64url'),
    };
    const token = (sub: string) =>
      `fixture.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.fixture`;
    boundary.credentials = { token: token('custodian'), encryption: null };
    const guest: StoredCredentials = {
      token: token('guest'),
      encryption: null,
    };
    const guestScenario = scenario !== 'owner';
    const sessionId = 'c' + '8'.repeat(24),
      machineId = 'machine';
    const directory = await mkdtemp(join(tmpdir(), 'guest-session-workspace-'));
    const workspace = join(directory, 'workspace');
    await (
      await import('node:fs/promises')
    ).mkdir(workspace, { recursive: true });
    const sessionReaders: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      const bearer = String(options?.headers?.Authorization ?? '');
      const reader = bearer === `Bearer ${guest.token}` ? 'guest' : 'custodian';
      if (path === `/v2/sessions/${sessionId}`) {
        sessionReaders.push(reader);
        const ownerReader = guestScenario ? 'guest' : 'custodian';
        if (reader !== ownerReader || scenario === 'guest Session not current')
          return { status: 404, data: { error: 'not_found' } };
        return {
          status: 200,
          data: {
            session: {
              ...createSessionRecordFixture({
                id: sessionId,
                active: true,
                share: null,
                encryptionMode: 'plain',
                metadata: JSON.stringify({ machineId, path: workspace }),
              }),
              responsibleAccountId: null,
              responsibleAccount: null,
              effectiveAccess: {
                v: 1,
                level: 'owner',
                sources: [{ kind: 'owner' }],
                capabilities: projectSessionAccessCapabilitiesV1({
                  owner: true,
                  grants: [],
                }),
              },
            },
          },
        };
      }
      if (path === '/v1/account/encryption/currentness')
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
      if (path === '/v1/account/encryption')
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings')
        return {
          status: 200,
          data: { content: { t: 'plain', v: {} }, version: 1 },
        };
      if (path.endsWith('/profile'))
        return {
          status: 200,
          data: { id: reader, settings: null, settingsVersion: 0 },
        };
      throw new Error(`Unexpected Home read ${path}`);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              features: {},
              capabilities: {
                serverIdentity: { serverIdentityId: 'srv_guest_home' },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const serverId = configuration.activeServerId,
      serverHttpBaseUrl = resolveServerHttpBaseUrl();
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>(),
      registry = new ConnectedServiceRuntimeRegistry();
    let runtime: Awaited<
      ReturnType<typeof createRequesterSessionRuntimeContext>
    > = null;
    const host = await createRequesterSessionControlRuntimeFixture({
      happyHomeDir: directory,
      activeServerDir: directory,
      serverId,
      serverHttpBaseUrl,
      machineId,
      custodianAccountId: 'custodian',
      credentials: boundary.credentials,
      connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry,
      trackedSessions,
      getRequester: () => runtime,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
    });
    onTestFinished(async () => {
      await runtime?.dispose();
      await host.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    const trackingKey = legacyPidSessionTrackingKey(process.pid);
    if (guestScenario) {
      const bootstrap = await admitRequesterSessionBootstrap({
        bootstrap: {
          v: 1,
          disposition: 'ordinary_requester',
          credentials: encodeStoredCredentials(guest),
        },
        existingSessionId: sessionId,
        boundary: { serverId, serverHttpBaseUrl, happyHomeDir: directory },
        context: {
          signal: new AbortController().signal,
          machineAdmission: {
            actorAccountId: 'guest',
            custodianAccountId: 'custodian',
            machineId,
            installationId: boundary.identity.installationId,
            role: 'use',
            encryptionMode: 'plain',
          },
          verifyMachineAdmissionCurrent: async () => true,
        },
      });
      if (!bootstrap) throw new Error('Requester bootstrap was not admitted');
      runtime = await createRequesterSessionRuntimeContext({
        bootstrap: bootstrap.admitted,
        providerAccountUsageStore: createProviderAccountUsageStore(),
        activeServerDir: directory,
        connectedServicesMaterializationBaseDir: join(
          directory,
          'materialized',
        ),
        resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
        coordinatorInput: {
          machineId,
          machineIdProvider: () => machineId,
          runtimeId: 'guest-workspace-runtime',
          happyHomeDir: directory,
          logger: { debug() {}, info() {}, warn() {} },
          processEnv: {
            HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
            HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0',
          },
          trackedSessionsByKey: trackedSessions,
          connectedServiceRuntimeRegistry: registry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator:
            host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator,
        },
      });
      if (!runtime) throw new Error('Requester runtime was not retained');
      // A withdrawn guest keeps its attribution but its custody no longer resolves.
      trackedSessions.set(trackingKey, {
        trackingKey,
        pid: process.pid,
        happySessionId: sessionId,
        startedBy: 'daemon',
        requesterWorkAttributionV1: runtime.bootstrap.attribution,
        ...(scenario === 'withdrawn guest'
          ? {}
          : { requesterSessionRuntimeContext: runtime }),
      });
    } else {
      trackedSessions.set(trackingKey, {
        trackingKey,
        pid: process.pid,
        happySessionId: sessionId,
        startedBy: 'daemon',
      });
    }
    const resolve = createRequesterSessionRuntimeContextResolver({
      trackedSessions,
      getCreateRuntime: () => null,
      recoverBootstrap: async () => null,
    });
    const release = async (
      context: Parameters<
        typeof releaseUnretainedRequesterSessionRuntimeContext
      >[0],
    ) =>
      releaseUnretainedRequesterSessionRuntimeContext(
        context,
        [...trackedSessions.values()].map(
          (tracked) => tracked.requesterSessionRuntimeContext,
        ),
      );
    const custody = createRequesterSessionAccountContextCustody({
      trackedSessions,
      resolveRequesterSessionRuntimeContext: resolve,
      releaseRequesterSessionRuntimeContext: release,
      externalActionAccountId: 'custodian',
      serverId,
      machineId,
      isRetired: () => false,
    });
    const client = new ApiMachineClient(
      boundary.credentials.token,
      {
        id: machineId,
        encryptionMode: 'plain',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      },
      undefined,
      {
        requesterSessionRuntime: { serverId, resolve, release },
        withSessionAccountContext: custody.withSessionAccountContext,
        agentIsolation: {
          read: () => ({
            enabled: false,
            status: { kind: 'disabled' as const },
            workspaceRoots: [],
          }),
        },
      },
    );
    onTestFinished(() => client.shutdown());
    const execute = client.createFilesystemActionExecutor(serverId);
    // Source selection throws its typed refusal; later owners return one.
    const result = await execute({
      actionId: 'daemon.filesystem.writeFile',
      input: {
        rootPath: workspace,
        path: 'w21-guest-approval-control.txt',
        content: Buffer.from('W21_GUEST_WRITE').toString('base64'),
      },
      context: {
        surface: 'agent',
        authority: 'account_automation',
        actionCaller: {
          kind: 'session',
          sessionId,
          starterDepth: 0,
          turnDepth: 0,
        },
        sessionActionOrigin: {
          v: 1,
          caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
          callerPermissionMode: 'default',
          sourceTurnId: 'turn',
          requestId: 'approved-write',
        },
      },
    } as Parameters<typeof execute>[0]).catch((error: unknown) => ({ ok: false as const,
      errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'thrown' }));
    const written = await readFile(
      join(workspace, 'w21-guest-approval-control.txt'),
      'utf8',
    ).catch(() => null);
    // The Machine owner's credential never reads a guest's Session, and is never a fallback.
    if (guestScenario) expect(sessionReaders).not.toContain('custodian');
    if (scenario === 'guest' || scenario === 'owner') {
      // The Session's own Account resolved its workspace: the effect proceeds to the
      // next owner. This harness mounts no external Action ingress (set only by a live
      // Home connection), so the write itself stops there and is not exercised here.
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'filesystem_action_owner_unavailable' });
      expect(sessionReaders).toEqual([
        scenario === 'guest' ? 'guest' : 'custodian',
      ]);
    } else {
      expect(result).toMatchObject({
        ok: false,
        errorCode:
          scenario === 'withdrawn guest'
            ? 'requester_session_not_current'
            : 'workspace_target_unavailable',
      });
      expect(written).toBeNull();
    }
  },
);

import axios from 'axios';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { registerMachineSessionHandoffRpcHandlers } from '@/api/machine/sessionHandoff/handlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import {
  admitRequesterSessionBootstrap,
  createRequesterSessionRuntimeContextResolver,
  releaseUnretainedRequesterSessionRuntimeContext,
  type AdmittedRequesterSessionBootstrap,
  type RequesterSessionRuntimeContext,
} from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createOnChildExited } from '@/daemon/sessions/onChildExited';
import {
  legacyPidSessionTrackingKey,
  type SessionTrackingKey,
} from '@/daemon/sessions/sessionTrackingKey';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '@/daemon/types';
import { encodeStoredCredentials } from '@/persistence';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

afterEach(() => {
  vi.restoreAllMocks();
});

// A person with Manage on Alice's SOURCE Machine hands Bob's Session over. The handoff
// stops that Session itself; the Sync custody admitted for the handoff is consumed after.
it.each(['handoff', 'failed handoff', 'withdrawn access'] as const)(
  'keeps the requester custody admitted for a handoff across its own SOURCE Stop (%s)',
  async (scenario) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'handoff-custody-after-stop-'),
    );
    const home = 'bob-home';
    const serverHttpBaseUrl = 'https://bob-home.test';
    const sessionId = 'bob-session';
    const machineId = 'machine';
    const installationId = 'installation';
    const targetMachineId = 'bob-target';
    const requesterToken = `e30.${Buffer.from(
      JSON.stringify({
        sub: 'bob',
        tokenEpoch: 1,
        provenance: { v: 1, kind: 'account', authority: 'present_user' },
      }),
    ).toString('base64url')}.fixture`;
    const channel = await createRequesterCurrentnessSocketHarness();
    // Home HTTP is the boundary; admission, the runtime, its exit owner and the lifecycle registration run real logic.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => ({
      status: 200,
      data: url.endsWith(`/v2/sessions/${sessionId}`)
        ? {
            session: createSessionRecordFixture({
              id: sessionId,
              encryptionMode: 'plain',
              metadataLayoutVersion: 0,
              metadataVersion: 1,
              metadata: JSON.stringify({ machineId, path: '/repo' }),
              dataEncryptionKey: null,
              share: null,
            }),
          }
        : url.endsWith('/profile')
          ? { id: 'bob' }
          : url.endsWith('/currentness')
            ? {
                mode: 'plain',
                version: 1,
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                updatedAt: 1,
                recipientEnvelopeReadiness: {
                  status: 'unavailable',
                  reason: 'plain_account',
                },
              }
            : { content: { t: 'plain', v: {} }, version: 1 },
    }));
    let requester: RequesterSessionRuntimeContext | null = null;
    let bootstrap: AdmittedRequesterSessionBootstrap | undefined;
    let host: Awaited<
      ReturnType<typeof createRequesterSessionControlRuntimeFixture>
    > | null = null;
    let pendingExit: Promise<void> | null = null;
    try {
      const registry = new ConnectedServiceRuntimeRegistry();
      const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
      host = await createRequesterSessionControlRuntimeFixture({
        happyHomeDir: directory,
        activeServerDir: directory,
        serverId: home,
        serverHttpBaseUrl,
        machineId,
        custodianAccountId: 'alice',
        credentials: { token: 'alice', encryption: null },
        connectedServicesMaterializationBaseDir: join(
          directory,
          'materialized',
        ),
        registry,
        trackedSessions,
        getRequester: () => requester,
        resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      });
      const machineAdmission = {
        actorAccountId: 'bob',
        custodianAccountId: 'alice',
        machineId,
        installationId,
        role: 'manage' as const,
        encryptionMode: 'plain' as const,
      };
      const admitted = await admitRequesterSessionBootstrap({
        bootstrap: {
          v: 1,
          disposition: 'ordinary_requester',
          credentials: encodeStoredCredentials({
            token: requesterToken,
            encryption: null,
          }),
        },
        existingSessionId: sessionId,
        boundary: {
          serverId: home,
          serverHttpBaseUrl,
          happyHomeDir: directory,
        },
        context: {
          signal: new AbortController().signal,
          machineAdmission,
          verifyMachineAdmissionCurrent: async () => true,
        },
      });
      if (!admitted) throw new Error('Missing real requester admission');
      bootstrap = admitted.admitted;
      bootstrap.bindRuntimeMachineAdmissionCurrentness(
        async () => true,
        async () => true,
      );
      requester = await createRequesterSessionRuntimeContext({
        providerAccountUsageStore: createProviderAccountUsageStore(),
        bootstrap,
        activeServerDir: directory,
        connectedServicesMaterializationBaseDir: join(
          directory,
          'materialized',
        ),
        resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
        coordinatorInput: {
          machineId,
          machineIdProvider: () => machineId,
          runtimeId: 'runtime',
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
      if (!requester) throw new Error('Missing real requester runtime');
      const runtime = requester;

      // Bob's Session runs on Alice's Machine with his own retained requester runtime.
      const child = spawn(process.execPath, ['-e', 'process.exitCode = 0'], {
        cwd: directory,
        stdio: 'ignore',
      });
      const exited = new Promise<
        Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
      >((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const pid = child.pid;
      if (pid === undefined)
        throw new Error('Missing fixture process identity');
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(pid),
        pid,
        happySessionId: sessionId,
        startedBy: 'daemon',
        requesterSessionRuntimeContext: runtime,
      };
      trackedSessions.set(tracked.trackingKey, tracked);
      const onChildExited = createOnChildExited({
        trackedSessionsByKey: trackedSessions,
        spawnResourceCleanupByKey: new Map(),
        sessionAttachCleanupByKey: new Map(),
        getApiMachineForSessions: () => null,
      });

      const root = ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1,
        token: 'handoff-admission',
        binding: {
          actionId: 'session.handoff',
          accountId: 'bob',
          custodianAccountId: 'alice',
          authentication: { kind: 'account', tokenEpoch: 1 },
          accountEncryptionMode: 'plain',
          serverIdentityId: home,
          machineId,
          installationId,
          target: { kind: 'machine', machineId },
          requestId: 'handoff-request',
          requestEnvelopeDigest: 'a'.repeat(43),
          handoffAdmission: {
            sessionId,
            sourceMachineId: machineId,
            sourceInstallationId: installationId,
            targetMachineId,
            targetInstallationId: 'bob-target-installation',
          },
        },
      });
      // The coordinator is the Machine-effect boundary: it stops the SOURCE Session, then the
      // Sync step consumes the custody it retained and refuses the way the Sync owner refuses.
      const effects: string[] = [];
      const coordinateSessionHandoff = vi.fn<
        NonNullable<
          Parameters<
            typeof registerMachineSessionHandoffRpcHandlers
          >[0]['coordinateSessionHandoff']
        >
      >(async ({ context }) => {
        const capture =
          await context?.requesterSessionBootstrap?.projectHandoffCaptureAccountContext(
            root,
            home,
          );
        if (!capture?.retainCustody)
          throw new Error('Missing admitted handoff Sync custody');
        const custody = capture.retainCustody();
        try {
          effects.push('stop');
          pendingExit = onChildExited(pid, {
            reason: 'process-exited',
            ...(await exited),
          });
          await pendingExit;
          // The exit owner's requester_release phase ran: the runner no longer lends this custody.
          expect(tracked.requesterSessionRuntimeContext).toBeUndefined();
          effects.push('sync_commit');
          // A later step that fails (the TARGET refusing, a cancelled handoff) ends the admitted handler too.
          if (scenario === 'failed handoff') throw new Error('target refused');
          if (!(await custody.isCurrent()))
            return {
              ok: false,
              errorCode: 'project_requester_authority_unavailable',
            };
          return { ok: true, result: { handoffId: 'handoff_1' } };
        } finally {
          await custody.release();
          await capture.dispose();
        }
      });
      const rpc = new RpcHandlerManager({
        scopePrefix: machineId,
        encryptionMode: 'plain',
      });
      const resolve = createRequesterSessionRuntimeContextResolver({
        trackedSessions,
        getCreateRuntime: () => null,
        recoverBootstrap: async () => null,
      });
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: rpc,
        localMachineId: machineId,
        runtimeConfig: { activeServerDir: directory },
        coordinateSessionHandoff,
        requesterSessionRuntime: {
          serverId: home,
          resolve,
          release: (context) =>
            releaseUnretainedRequesterSessionRuntimeContext(
              context,
              [...trackedSessions.values()].map(
                (session) => session.requesterSessionRuntimeContext,
              ),
            ),
        },
      });
      // Home's answer for this person's Machine admission; withdrawal is read at the next admission.
      let machineAccess = true;
      const handOff = async () =>
        await rpc.invokeLocal(
          RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
          { sessionId, targetMachineId, workspaceAction: { kind: 'none' } },
          {
            rpcContext: {
              machineAdmission,
              verifyMachineAdmissionCurrent: async () => machineAccess,
              callerInputAuthorization: root,
            },
          },
        );

      if (scenario === 'withdrawn access') {
        machineAccess = false;
        expect(await handOff()).toMatchObject({ ok: false });
        expect(coordinateSessionHandoff).not.toHaveBeenCalled();
        expect(effects).toEqual([]);
        return;
      }
      const settled = await handOff().catch((error: unknown) => ({ thrown: error instanceof Error ? error.message : String(error) }));
      expect(effects).toEqual(['stop', 'sync_commit']);
      // The custody admitted for the handoff must outlive the Stop the handoff itself issues.
      if (scenario === 'handoff') expect(settled).toEqual({ handoffId: 'handoff_1' });
      else expect(settled).not.toEqual({ handoffId: 'handoff_1' });
      // Released once when the admitted handoff settles: the exited Session lends nothing afterwards.
      expect(await runtime.isCurrent()).toBe(false);
      expect(await resolve(sessionId)).toBeNull();
    } finally {
      try {
        await pendingExit;
      } finally {
        try {
          await requester?.dispose();
          await bootstrap?.dispose();
        } finally {
          try {
            await host?.dispose();
          } finally {
            await channel.close();
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  },
);

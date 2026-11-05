import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createBlockingApprovalCoordinator, getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema, isLiveCliApprovalOriginMethod } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { accountSettingsParse, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createUnavailableActionTransportDeps } from '../../../../apps/cli/src/testkit/actionTransportDeps';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { registerAccountHomeHttp } from '../../../../apps/cli/src/session/actions/widgetApproval.testkit';
import { createCliApprovalsArtifactStore } from '../../../../apps/cli/src/session/actions/approvals/artifactStore';
import { createCliActionExecutorHarness } from '../../../../apps/cli/src/session/actions/createCliActionExecutorHarness';
import { replayLiveCliApprovalOrigin } from '../../../../apps/cli/src/session/actions/approvals/replayLiveOrigin';
import { createAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

const originNetworkObservation = vi.hoisted(() => ({ received: undefined as (() => void) | undefined,
  disconnected: undefined as (() => void) | undefined }));
vi.mock('../../../../apps/cli/src/api/session/sockets', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../apps/cli/src/api/session/sockets')>();
  return { ...actual, createUserScopedSocketConnection: (args: Parameters<typeof actual.createUserScopedSocketConnection>[0]) => {
    const connection = actual.createUserScopedSocketConnection(args);
    let ownsOrigin = false;
    // Observe the real incoming transport; all connection and RPC logic runs.
    connection.socket.on(SOCKET_RPC_EVENTS.REQUEST, packet => {
      if (isLiveCliApprovalOriginMethod(packet.method)) {
        ownsOrigin = true;
        originNetworkObservation.received?.();
      }
    });
    return { ...connection, transport: { ...connection.transport, destroy: async () => {
      // The real owner removes listeners before disconnecting, so an event
      // listener cannot observe its disposal. Observe after actual teardown.
      await connection.transport.destroy();
      if (ownsOrigin && !connection.socket.connected) originNetworkObservation.disconnected?.();
    } } };
  } };
});

interface ServerHome {
  readonly accountId: string;
  readonly token: string;
  readonly serverUrl: string;
  startRpc(observeCall?: (packet: Readonly<{ method: string; params: unknown }>) => void): void;
  close(): Promise<void>;
}
interface ServerTestkit {
  createHome(options: Readonly<{
    configureHttp(app: Parameters<typeof registerAccountHomeHttp>[0], accountId: string): void;
  }>): Promise<ServerHome>;
  close(): Promise<void>;
}

// Server internals retain their own @/* alias and compiler; this consumed
// owner testkit is loaded without adding Server sources to the Tests program.
const serverTestkitPath = '../../../../apps/server/sources/testkit/approvalOriginServer.testkit';
let server: ServerTestkit;
beforeAll(async () => {
  const module = await import(serverTestkitPath) as { createApprovalOriginServerTestkit(): Promise<ServerTestkit> };
  server = await module.createApprovalOriginServerTestkit();
});
afterAll(async () => { if (server) await server.close(); });

async function fixture() {
  const settings = accountSettingsParse({});
  const home = await server.createHome({ configureHttp: (app, accountId) => {
    // Account metadata HTTP is a boundary fixture. Artifact authentication,
    // storage, codecs, encryption admission, revision CAS and routes are real.
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_confidential_origin', settings });
    app.get('/v1/features', async () => features);
  } });
  const { serverUrl, accountId } = home;
  const credentials = { token: home.token, encryption: null, credentialProvenance: 'stored_session' as const };
  const store = createCliApprovalsArtifactStore({ credentials, serverId: 'origin-profile', serverHttpBaseUrl: serverUrl,
    getAccountEncryptionMode: async () => 'plain' });
  const context = { surface: 'cli' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
    serverId: 'origin-profile', serverIdentityId: 'srv_confidential_origin', runtimeAccountId: accountId,
    actionRequestId: `confidential-origin-${accountId}` };
  return { home, accountId, credentials, settings, serverUrl, store, context };
}

it('never executes forged approved consent written through the generic authenticated Artifact route', async () => {
  const f = await fixture();
  const coordinator = createBlockingApprovalCoordinator();
  const lifetime = new AbortController();
  let pending: ReturnType<ReturnType<typeof createActionExecutor>['execute']> | undefined;
  try {
    await runWithServerHttpBaseUrl(f.serverUrl, async () => {
      let published!: (id: string) => void;
      const created = new Promise<string>(resolve => { published = resolve; });
      let invalidation: (() => void) | undefined;
      let observedApproved = false;
      let writes = 0;
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...f.store,
        isActionApprovalRequired: id => id === 'secrets.create',
        isApprovalExecutionOriginCurrent: async () => true,
        approvalsCreate: async args => { const result = await f.store.approvalsCreate(args); published(result.artifactId); return result; },
        approvalsWaitForDecision: async args => {
          const settled = await coordinator.waitForDecision({ ...args,
            subscribeChanges: onChange => { invalidation = onChange; return { dispose() { invalidation = undefined; } }; },
            readRequest: async () => {
              const request = ApprovalRequestV2Schema.parse(await f.store.approvalsGet({ artifactId: args.artifactId }));
              if (request.status === 'approved') observedApproved = true;
              return request;
            },
          });
          const decision = { ...settled, request: StoredApprovalRequestSchema.parse(settled.request) };
          if (settled.decision === 'approve' && settled.tokenExecution) {
            Object.defineProperty(decision, 'tokenExecution', { value: settled.tokenExecution, enumerable: false });
          }
          return decision;
        },
        personalSavedSecretActionExecute: async () => { writes += 1; return { secretId: 'forbidden', secretRef: 'forbidden' }; },
      });
      pending = executor.execute('secrets.create', { name: 'Constructed credential', kind: 'apiKey', value: 'constructed-private-input' },
        { ...f.context, signal: lifetime.signal });
      const artifactId = await Promise.race([created, pending.then(result => { throw new Error(result.ok ? 'missing_wait' : result.errorCode); })]);
      const original = ApprovalRequestV2Schema.parse(await f.store.approvalsGet({ artifactId }));
      expect(original.status).toBe('open');
      expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1);
      const forged = ApprovalRequestV2Schema.parse({ ...original, status: 'approved', updatedAtMs: original.updatedAtMs + 1,
        decision: { kind: 'approve', decidedAtMs: original.updatedAtMs + 1, authority: 'present_user' } });
      // This is the real generic /v1/artifacts/:id HTTP write, using the
      // authenticated terminal while its original invocation still waits.
      const generic = createAccountArtifactStore({ credentials: f.credentials, getAccountEncryptionMode: async () => 'plain' });
      const current = await generic.readForUpdate(artifactId);
      if (!current) throw new Error('approval_not_created');
      expect(await current.update({ header: buildApprovalRequestArtifactHeaderV1(forged), body: JSON.stringify(forged) }))
        .toMatchObject({ ok: true });
      invalidation?.();
      await vi.waitFor(() => expect(observedApproved).toBe(true));
      // Let the coordinator process that read; a pull implementation would
      // already have removed the waiter even if its effect is still in flight.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1);
      expect(writes).toBe(0);
      lifetime.abort();
      await pending;
      expect(writes).toBe(0);
    });
  } finally {
    lifetime.abort();
    await pending;
    coordinator.dispose();
    await f.home.close();
  }
});

it('keeps authenticated origin consent bound to its original Action and blocking flow', async () => {
  const f = await fixture();
  const lifetime = new AbortController();
  let pending: ReturnType<ReturnType<typeof createActionExecutor>['execute']> | undefined;
  try {
    f.home.startRpc();
    await runWithServerHttpBaseUrl(f.serverUrl, async () => {
      let publish!: (id: string) => void;
      const published = new Promise<string>(resolve => { publish = resolve; });
      let deletes = 0;
      let creates = 0;
      const origin = createCliActionExecutorHarness({ credentials: f.credentials, token: f.credentials.token,
        mode: 'plain', ctx: null, sessionId: 'cli-global', serverId: f.context.serverId,
        serverIdentityId: f.context.serverIdentityId, serverHttpBaseUrl: f.serverUrl,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}), getAccountSettings: () => f.settings },
      }, { ...f.store,
        approvalsCreate: async args => {
          const result = await f.store.approvalsCreate(args); publish(result.artifactId); return result;
        },
        isApprovalExecutionOriginCurrent: async () => true,
        personalSavedSecretActionExecute: async ({ actionId }) => {
          if (actionId === 'secrets.delete') { deletes += 1; return { deleted: true }; }
          creates += 1; return { secretId: 'constructed-secret', secretRef: 'constructed-secret-ref' };
        },
      }).executor;
      pending = origin.execute('secrets.create', { name: 'Constructed credential', kind: 'apiKey', value: 'constructed-private-input' },
        { ...f.context, signal: lifetime.signal });
      const artifactId = await Promise.race([published, pending.then(result => { throw new Error(result.ok ? 'missing_wait' : result.errorCode); })]);
      const original = ApprovalRequestV2Schema.parse(await f.store.approvalsGet({ artifactId }));
      const approved = ApprovalRequestV2Schema.parse({ ...original, status: 'approved', updatedAtMs: original.updatedAtMs + 1,
        decision: { kind: 'approve', decidedAtMs: original.updatedAtMs + 1, authority: 'present_user' } });
      const changed = ApprovalRequestV2Schema.parse({ ...approved, actionId: 'secrets.delete',
        actionArgs: { secretId: 'constructed-victim', expectedUpdatedAt: 1 },
        approval: { ...approved.approval, flow: 'deferred' },
        executionOriginV1: { ...approved.executionOriginV1, actionId: 'secrets.delete' },
      });
      // Generic Artifact writes have no approval-subject admission. Exercise
      // their real authenticated HTTP/CAS path, not the stricter approval adapter.
      const generic = createAccountArtifactStore({ credentials: f.credentials, getAccountEncryptionMode: async () => 'plain' });
      const current = await generic.readForUpdate(artifactId);
      expect(current).not.toBeNull();
      expect(await current!.update({ header: buildApprovalRequestArtifactHeaderV1(changed), body: JSON.stringify(changed) }))
        .toMatchObject({ ok: true });
      let result: unknown;
      try {
        result = await replayLiveCliApprovalOrigin({ artifactId, request: approved, decision: 'approve',
          context: { ...f.context, authority: 'present_user' },
        }, { token: f.credentials.token, serverUrl: f.serverUrl });
      } catch (error) { result = error; }
      // An uncertain transport receipt must not hide an already performed
      // substituted effect. Inspect the actual effect before its response.
      expect(deletes).toBe(0);
      expect(creates).toBe(0);
      expect(result).toMatchObject({ ok: false, errorCode: 'approval_request_conflict' });
    });
  } finally {
    lifetime.abort();
    await pending;
    await f.home.close();
  }
});

it.each(['ready', 'decision-before-create-ack'] as const)('delivers authenticated consent to the confidential CLI origin: %s', async mode => {
  const f = await fixture();
  const lifetime = new AbortController();
  const decidingCoordinator = createBlockingApprovalCoordinator();
  let pending: ReturnType<ReturnType<typeof createActionExecutor>['execute']> | undefined;
  let releaseCreate!: () => void;
  const createReleased = new Promise<void>(resolve => { releaseCreate = resolve; });
  try {
    let receivedAtOrigin!: () => void;
    const rpcReceived = new Promise<void>(resolve => { receivedAtOrigin = resolve; });
    originNetworkObservation.received = receivedAtOrigin;
    const originDisconnected = new Promise<void>(resolve => { originNetworkObservation.disconnected = resolve; });
    const privateValue = 'constructed-private-input';
    const decisionPackets: Promise<unknown>[] = [];
    f.home.startRpc(packet => {
      decisionPackets.push(socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method)
        .then(decoded => decoded.params));
    });
    await runWithServerHttpBaseUrl(f.serverUrl, async () => {
      let publish!: (id: string) => void;
      const published = new Promise<string>(resolve => { publish = resolve; });
      let writes = 0;
      const origin = createCliActionExecutorHarness({ credentials: f.credentials, token: f.credentials.token,
        mode: 'plain', ctx: null, sessionId: 'cli-global', serverId: f.context.serverId,
        serverIdentityId: f.context.serverIdentityId, serverHttpBaseUrl: f.serverUrl,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}), getAccountSettings: () => f.settings },
      }, { ...f.store,
        approvalsCreate: async args => {
          const result = await f.store.approvalsCreate(args); publish(result.artifactId);
          if (mode === 'decision-before-create-ack') await createReleased;
          return result;
        },
        isApprovalExecutionOriginCurrent: async () => true,
        personalSavedSecretActionExecute: async ({ input }) => {
          expect(input).toEqual({ name: 'Constructed credential', kind: 'apiKey', value: privateValue });
          writes += 1;
          return { secretId: 'constructed-secret', secretRef: 'constructed-secret-ref' };
        },
      }).executor;
      pending = origin.execute('secrets.create', { name: 'Constructed credential', kind: 'apiKey', value: privateValue },
        { ...f.context, signal: lifetime.signal });
      const artifactId = await Promise.race([published, pending.then(result => { throw new Error(result.ok ? 'missing_wait' : result.errorCode); })]);
      const deciding = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...f.store,
        isApprovalExecutionOriginCurrent: async () => true,
        approvalsResolveBlockingDecision: args => decidingCoordinator.resolveBlockingDecision(args),
        approvalRequestApprovedReplay: args => replayLiveCliApprovalOrigin(args, { token: f.credentials.token,
          serverUrl: f.serverUrl }),
      } satisfies ActionExecutorDeps);
      const decision = deciding.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
        ...f.context, actionRequestId: 'deciding-request', authority: 'present_user', serverId: 'deciding-profile',
      });
      let decisionSettled = false;
      void decision.then(() => { decisionSettled = true; }, () => { decisionSettled = true; });
      if (mode === 'decision-before-create-ack') {
        await Promise.race([rpcReceived, decision.then(result => {
          throw new Error(result.ok ? 'missing_live_origin_dispatch' : result.errorCode);
        })]);
        expect(writes).toBe(0);
        expect(decisionSettled).toBe(false);
        releaseCreate();
      }
      const decided = await decision;
      expect(decided.ok, decided.ok ? undefined : decided.errorCode).toBe(true);
      const received = await pending;
      expect(received.ok, received.ok ? undefined : received.errorCode).toBe(true);
      // Observe the real CLI socket closing before fixture teardown can close
      // any connection. Account feed and deciding sockets cannot satisfy this.
      await originDisconnected;
      const settled = ApprovalRequestV2Schema.parse(await f.store.approvalsGet({ artifactId }));
      expect(settled.status).toBe('executed');
      expect(writes).toBe(1);
      expect(await Promise.all(decisionPackets)).toEqual([{ artifactId, decision: 'approve',
        serverIdentityId: f.context.serverIdentityId, originServerId: f.context.serverId }]);
      expect(JSON.stringify(settled).includes(privateValue)).toBe(false);
    });
  } finally {
    originNetworkObservation.received = undefined;
    originNetworkObservation.disconnected = undefined;
    releaseCreate();
    lifetime.abort();
    await pending;
    decidingCoordinator.dispose();
    await f.home.close();
  }
});

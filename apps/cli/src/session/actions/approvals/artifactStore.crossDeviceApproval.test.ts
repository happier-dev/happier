import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovalRequestSchema,
  artifactIdScopeMatchesAccountV1,
  ApprovalRequestV2Schema,
  ManagedAcquireInputV1Schema,
  createActionExecutor,
  createBlockingApprovalCoordinator,
  type ActionExecutorDeps,
  type ApprovalExecutionOriginV1,
  type ApprovalRequest,
} from '@happier-dev/protocol';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { Credentials } from '@/persistence';

import { createCliApprovalsArtifactStore } from './artifactStore';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';

const { mockGet, mockPost, fixtureConfiguration } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  fixtureConfiguration: { apiServerUrl: 'http://127.0.0.1:24599', activeServerDir: '' },
}));

vi.mock('axios', () => ({
  default: {
    defaults: {},
    get: mockGet,
    post: mockPost,
  },
}));

vi.mock('@/configuration', () => ({
  configuration: fixtureConfiguration,
}));

type StoredArtifact = {
  id: string;
  ownerAccountId: string;
  access: 'owner';
  encryptionMode: 'e2ee';
  header: string;
  headerVersion: number;
  body: string;
  bodyVersion: number;
  dataEncryptionKey: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
};

describe('approval Artifact cross-device decision', () => {
  let artifacts: Map<string, StoredArtifact>;
  let fixtureDirectory: string;

  beforeEach(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'happier-approval-cross-device-'));
    fixtureConfiguration.activeServerDir = fixtureDirectory;
    artifacts = new Map();
    mockGet.mockReset();
    mockPost.mockReset();

    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/recipients')) {
        const artifactId = decodeURIComponent(url.split('/').at(-3) ?? '');
        const artifact = artifacts.get(artifactId);
        return { status: 200, data: { artifactId, ownerAccountId: 'account', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: artifact?.dataEncryptionKey, callerDataEncryptionKey: artifact?.dataEncryptionKey, recipients: [] } };
      }
      const artifactId = decodeURIComponent(url.split('/').at(-1) ?? '');
      const artifact = artifacts.get(artifactId);
      return artifact
        ? { status: 200, data: artifact }
        : { status: 404, data: { error: 'not_found' } };
    });
    mockPost.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/v1/artifacts')) {
        const id = String(body.id);
        if (!artifactIdScopeMatchesAccountV1({ artifactId: id, accountId: 'account', idScope: body.idScope }))
          return { status: 400, data: { error: 'Invalid parameters' } };
        // Home returns the incumbent row, without rewriting it, on an exact-id create.
        if (artifacts.has(id)) return { status: 200, data: artifacts.get(id) };
        artifacts.set(id, {
          id,
          ownerAccountId: 'account', access: 'owner', encryptionMode: 'e2ee',
          header: String(body.header),
          headerVersion: 1,
          body: String(body.body),
          bodyVersion: 1,
          dataEncryptionKey: String(body.dataEncryptionKey),
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
        });
        return { status: 200, data: artifacts.get(id) };
      }

      const artifactId = decodeURIComponent(url.split('/').at(-1) ?? '');
      const current = artifacts.get(artifactId);
      if (!current) return { status: 404, data: { error: 'not_found' } };
      if (
        body.expectedHeaderVersion !== current.headerVersion
        || body.expectedBodyVersion !== current.bodyVersion
      ) {
        return { status: 200, data: { success: false, error: 'version-mismatch' } };
      }
      const next: StoredArtifact = {
        ...current,
        header: String(body.header),
        headerVersion: current.headerVersion + 1,
        body: String(body.body),
        bodyVersion: current.bodyVersion + 1,
        seq: current.seq + 1,
        updatedAt: current.updatedAt + 1,
      };
      artifacts.set(artifactId, next);
      return {
        status: 200,
        data: {
          success: true,
          headerVersion: next.headerVersion,
          bodyVersion: next.bodyVersion,
        },
      };
    });
  });

  afterEach(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it('rejoins a contributed Action request identity and refuses a changed input', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials: Credentials = { token: 'account-token', encryption: {
      type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
    } };
    const createStore = () => createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'original' },
      sourceCustody: { kind: 'development', registeredRootId: 'root' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', accountId: 'account', actionId: 'action.invoke', requestId: 'contributed-request' },
    });
    const [first, repeated] = await Promise.all([
      createStore().targetActionApprovalsCreate({ request }),
      createStore().targetActionApprovalsCreate({ request: { ...request, createdAtMs: 2, updatedAtMs: 2 } }),
    ]);
    expect(repeated.artifactId).toBe(first.artifactId);
    expect(repeated.request).toEqual(first.request);
    await expect(createStore().targetActionApprovalsCreate({ request: { ...request,
      input: { value: 'changed' }, subjectFingerprint: 'c'.repeat(64) } }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(artifacts.size).toBe(1);
    expect(await createStore().targetActionApprovalsGet(first)).toEqual(first.request);
  });

  it('rejoins one E2EE portable-Home request across local profiles and refuses changed operands without a write', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials: Credentials = { token: 'account-token', encryption: {
      type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
    } };
    const createStore = () => createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'session.title.set', summary: 'Set title',
      actionArgs: { sessionId: 'session', title: 'Original' },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'srv_home', serverIdentityId: 'srv_home', accountId: 'account', actionId: 'session.title.set', requestId: 'stable-request' },
    });
    const first = await createStore().approvalsCreate({ request, serverId: 'creator-profile' });
    const stored = artifacts.get(first.artifactId);
    const writes = mockPost.mock.calls.length;
    const repeated = await createStore().approvalsCreate({ request: { ...request, createdAtMs: 2, updatedAtMs: 2 }, serverId: 'approver-profile' });
    expect(repeated.artifactId).toBe(first.artifactId);
    expect(repeated.request).toEqual(request);
    await expect(createStore().approvalsCreate({ request: { ...request, actionArgs: { sessionId: 'session', title: 'Changed' } } }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(mockPost.mock.calls.length).toBe(writes);
    expect(artifacts.size).toBe(1);
    expect(artifacts.get(first.artifactId)).toBe(stored);
    expect(await createStore().approvalsGet(first)).toEqual(request);
  });

  it('separates a managed acquire approval from its guest policy child with the same retained request correlation', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials: Credentials = { token: 'account-token', encryption: {
      type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
    } };
    const store = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
    const origin = { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'srv_home', accountId: 'account', requestId: 'retained-creation' };
    const root = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'machines.managed.acquire', summary: 'Acquire guest',
      actionArgs: ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier',
        serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation: 'preauthorized' }, selection: { kind: 'one-off', homeId: 'srv_home',
        controller: { machineId: 'controller', installationId: 'controller-installation' },
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }),
      executionOriginV1: { ...origin, actionId: 'machines.managed.acquire', machineId: 'controller',
        target: { kind: 'machine', machineId: 'controller' } } });
    const policyInput = { serverId: 'srv_home', machineId: 'guest', expectedMetadataVersion: 0,
      expectedAdminAccess: { version: 1, mode: 'none' }, adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field' };
    const child = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 2, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, actionId: 'machines.setup.adminAccess.set', summary: 'Set guest administrator policy',
      actionArgs: policyInput,
      executionOriginV1: { ...origin, actionId: 'machines.setup.adminAccess.set', machineId: 'guest',
        target: { kind: 'machine', machineId: 'guest' } } });
    const acquired = await store.approvalsCreate({ request: root, serverId: 'home' });
    const policy = await store.approvalsCreate({ request: child, serverId: 'home' });
    expect(policy.artifactId).not.toBe(acquired.artifactId);
    expect(artifacts.size).toBe(2);
    expect(await store.approvalsGet(acquired)).toEqual(root);
    expect(await store.approvalsGet(policy)).toEqual(child);
    expect(await store.approvalsCreate({ request: child, serverId: 'home' })).toEqual(policy);
    await expect(store.approvalsCreate({ request: { ...child, actionArgs: { ...policyInput,
      adminAccess: { version: 1, mode: 'none' } } }, serverId: 'home' }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(artifacts.size).toBe(2);
  });

  it('retains the first private Discussion draft across explicit/final retries and terminal settlement', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials: Credentials = { token: 'account-token', encryption: {
      type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
    } };
    const createStore = () => createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
    const store = createStore();
    const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: 'receiver', localId: 'original-input', acceptedTurnId: 'turn' });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'receiver' }, actionId: 'discussion.reply', summary: 'Review answer',
      approval: { flow: 'deferred', result: 'required' },
      actionArgs: { discussionId: 'discussion', localId, replyTarget: { kind: 'message', messageId: 'question' },
        content: { v: 1, parts: [{ t: 'text', text: 'Captured explicit draft' }] } },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
        caller: { kind: 'session', sessionId: 'receiver', starterDepth: 0, turnDepth: 0 },
        sessionId: 'receiver', serverId: 'profile-a', serverIdentityId: 'stable-home', machineId: 'machine', accountId: 'account',
        actionId: 'discussion.reply', requestId: localId,
        discussionReplyReturn: { serverId: 'stable-home', requestLocalId: 'original-input', acceptedTurnId: 'turn' },
        sessionInputSource: { sourceSessionId: 'receiver', sourceInputId: 'original-input', sourceTurnId: 'turn', via: 'action',
          discussionAddressing: { discussionId: 'discussion', messageId: 'question', throughSeq: 1, participantSessionId: 'receiver' } },
      } });
    const first = await store.approvalsCreate({ request, serverId: 'profile-a' });
    // Acknowledged creation needs only the scoped and retained-identity absence lookups.
    expect(mockGet.mock.calls.filter(([url]) => /\/v1\/artifacts\/[^/]+$/.test(String(url)))).toHaveLength(2);
    const retry = ApprovalRequestV2Schema.parse({ ...request, createdAtMs: 5, updatedAtMs: 5,
      actionArgs: { ...request.actionArgs as object, content: { v: 1, parts: [{ t: 'text', text: 'Later terminal fallback' }] } },
      executionOriginV1: { ...request.executionOriginV1, caller: { kind: 'host' }, serverId: 'profile-b' } });
    await expect(createStore().approvalsCreate({ request: retry, serverId: 'profile-b' }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    const unchangedRetry = ApprovalRequestV2Schema.parse({ ...request, createdAtMs: 5, updatedAtMs: 5,
      executionOriginV1: { ...request.executionOriginV1, serverId: 'profile-b' } });
    expect(await createStore().approvalsCreate({ request: unchangedRetry, serverId: 'profile-b' })).toEqual(first);
    expect(await store.approvalsGet(first)).toEqual(request);
    expect(artifacts.size).toBe(1);
    const approved = ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 } });
    const executing = ApprovalRequestV2Schema.parse({ ...approved, status: 'executing', updatedAtMs: 3 });
    const executed = ApprovalRequestV2Schema.parse({ ...executing, status: 'executed', updatedAtMs: 4,
      execution: { executedAtMs: 4, ok: true, result: { published: true } } });
    for (const settled of [approved, executing, executed]) {
      expect(await store.approvalsUpdate({ ...first, request: settled })).toEqual({ ok: true });
      expect(await createStore().approvalsCreate({ request: unchangedRetry, serverId: 'profile-b' }))
        .toEqual({ artifactId: first.artifactId, request: settled });
      expect(await store.approvalsGet(first)).toEqual(settled);
    }
    expect(artifacts.size).toBe(1);
    const differentQuestion = ApprovalRequestV2Schema.parse({ ...retry, actionArgs: { ...request.actionArgs as object,
      discussionId: 'another-discussion' } });
    await expect(createStore().approvalsCreate({ request: differentQuestion, serverId: 'profile-b' }))
      .rejects.toMatchObject({ code: 'subject_mismatch' });
    expect(await store.approvalsGet(first)).toEqual(executed);
    await expect(store.approvalsCreate({ request: ApprovalRequestV2Schema.parse({ ...request,
      actionArgs: { ...request.actionArgs as object, localId: 'unbound-tool-call' } }), serverId: 'profile-a' }))
      .rejects.toMatchObject({ code: 'subject_mismatch' });

    const nextLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: 'receiver', localId: 'next-input', acceptedTurnId: 'next-turn' });
    const nextQuestion = ApprovalRequestV2Schema.parse({ ...request, actionArgs: { ...request.actionArgs as object, localId: nextLocalId,
      replyTarget: { kind: 'message', messageId: 'next-question' } },
      executionOriginV1: { ...request.executionOriginV1, requestId: nextLocalId,
        discussionReplyReturn: { serverId: 'stable-home', requestLocalId: 'next-input', acceptedTurnId: 'next-turn' },
        sessionInputSource: { ...request.executionOriginV1.sessionInputSource,
          sourceInputId: 'next-input', sourceTurnId: 'next-turn', discussionAddressing: {
            discussionId: 'discussion', messageId: 'next-question', throughSeq: 2, participantSessionId: 'receiver' } } } });
    // A concurrent creator commits the same row before returning its conflict.
    const createAtBoundary = mockPost.getMockImplementation()!;
    mockPost.mockImplementationOnce(async (url: string, body: Record<string, unknown>) => {
      await createAtBoundary(url, body);
      return { status: 409, data: { error: 'conflict' } };
    });
    const next = await createStore().approvalsCreate({ request: nextQuestion, serverId: 'profile-a' });
    expect(next).not.toEqual(first);
    const rejected = ApprovalRequestV2Schema.parse({ ...nextQuestion, status: 'rejected', updatedAtMs: 2,
      decision: { kind: 'reject', authority: 'present_user', decidedAtMs: 2 } });
    expect(await store.approvalsUpdate({ ...next, request: rejected })).toEqual({ ok: true });
    expect(await createStore().approvalsCreate({ request: nextQuestion, serverId: 'profile-a' }))
      .toEqual({ artifactId: next.artifactId, request: rejected });
    expect(await store.approvalsGet(next)).toEqual(rejected);
    expect(artifacts.size).toBe(2);
  });

  it('decides a creator-profile artifact from another profile on the same Home exactly once', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials: Credentials = {
      token: 'account-token',
      encryption: {
        type: 'dataKey',
        machineKey,
        publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
      },
    };
    const store = createCliApprovalsArtifactStore({
      credentials,
      getAccountEncryptionMode: async () => 'e2ee',
    });
    const creatorProfileId = 'profile-creator-a';
    const decidingProfileId = 'profile-decider-b';
    const stableHomeId = 'srv_shared_home';
    const request = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'mcp', sessionId: 'session-1' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'mcp',
        caller: { kind: 'host' },
        accountId: 'account',
        serverId: creatorProfileId,
        serverIdentityId: stableHomeId,
        machineId: 'machine-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Cross-device approval' },
      summary: 'Set title',
    });
    const created = await store.approvalsCreate({ request, serverId: creatorProfileId });
    const coordinator = createBlockingApprovalCoordinator();
    let onArtifactChange = () => {};
    const disposeObservation = vi.fn();
    const waitingForRemoteResult = coordinator.waitForDecision({
      artifactId: created.artifactId,
      request,
      readRequest: () => store.approvalsGet({ artifactId: created.artifactId, serverId: creatorProfileId }),
      subscribeChanges: (onChange) => {
        onArtifactChange = onChange;
        return { dispose: disposeObservation };
      },
    });
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const executor = createActionExecutor({
      ...store,
      sessionStateFieldSet,
      isApprovalExecutionOriginCurrent: async ({ origin }: Readonly<{ origin: ApprovalExecutionOriginV1 }>) => (
        origin.serverIdentityId === stableHomeId
        && origin.accountId === 'account'
        && origin.machineId === 'machine-1'
      ),
    } as unknown as ActionExecutorDeps);

    const decide = (
      artifactId: string,
      originServerId: string,
      serverIdentityId: string,
      observedServerIdentityId = stableHomeId,
    ) => executor.execute(
      'approval.request.decide',
      {
        artifactId,
        decision: 'approve',
        originServerId,
        serverIdentityId,
      },
      {
        surface: 'ui',
        authority: 'present_user',
        serverId: decidingProfileId,
        serverIdentityId: observedServerIdentityId,
      },
    );

    await expect(decide(created.artifactId, creatorProfileId, stableHomeId)).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });
    // Account-change is a transport wake only; the waiter opens the durable E2EE result.
    onArtifactChange();
    await expect(waitingForRemoteResult).resolves.toMatchObject({
      decision: 'approve', request: { status: 'executed', execution: { ok: true } },
    });
    expect(disposeObservation).toHaveBeenCalledTimes(1);
    await expect(decide(created.artifactId, creatorProfileId, stableHomeId)).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });
    expect(sessionStateFieldSet).toHaveBeenCalledOnce();

    const persisted = await store.approvalsGet({
      artifactId: created.artifactId,
      serverId: decidingProfileId,
    });
    expect(persisted?.status).toBe('executed');
    expect((persisted as Extract<ApprovalRequest, { v: 2 }>).executionOriginV1).toMatchObject({
      serverId: creatorProfileId,
      serverIdentityId: stableHomeId,
    });

    const staleRequest = ApprovalRequestV2Schema.parse({
      ...request,
      executionOriginV1: {
        ...request.executionOriginV1,
        requestId: 'request-stale-origin-1',
      },
      actionArgs: { sessionId: 'session-1', title: 'Must not execute' },
    });
    const staleCreated = await store.approvalsCreate({
      request: staleRequest,
      serverId: creatorProfileId,
    });
    await expect(decide(staleCreated.artifactId, 'wrong-creator', stableHomeId)).resolves.toMatchObject({
      ok: false, errorCode: 'approval_stale', effectAttempted: false,
    });
    expect(sessionStateFieldSet).toHaveBeenCalledOnce();
    const unclaimed = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: staleCreated.artifactId, serverId: decidingProfileId }));
    expect(unclaimed).toMatchObject({ status: 'approved' });
    expect(unclaimed?.execution).toBeUndefined();

    // Step 1 preserves consent on a pre-claim refusal; the correct origin can recover.
    await expect(decide(staleCreated.artifactId, creatorProfileId, stableHomeId)).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });
    await expect(decide(staleCreated.artifactId, creatorProfileId, stableHomeId)).resolves.toMatchObject({
      ok: true, result: { status: 'executed', execution: { ok: true } },
    });
    expect(sessionStateFieldSet).toHaveBeenCalledTimes(2);

    const persistedStale = await store.approvalsGet({
      artifactId: staleCreated.artifactId,
      serverId: decidingProfileId,
    });
    expect(persistedStale).toMatchObject({
      status: 'executed', execution: { ok: true },
    });
  });

  it('keeps released V1 approval history approved when execution refuses before a claim', async () => {
    const machineKey = new Uint8Array(32).fill(8);
    const store = createCliApprovalsArtifactStore({
      credentials: {
        token: 'account-token',
        encryption: {
          type: 'dataKey',
          machineKey,
          publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
        },
      },
      getAccountEncryptionMode: async () => 'e2ee',
    });
    const request = ApprovalRequestSchema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'mcp', sessionId: 'session-1' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Must not execute' },
      summary: 'Set title',
      serverId: 'profile-creator-a',
    });
    const created = await store.approvalsCreate({ request, serverId: 'profile-creator-a' });
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const executor = createActionExecutor({ ...store, sessionStateFieldSet } as unknown as ActionExecutorDeps);

    const decision = await executor.execute(
      'approval.request.decide',
      { artifactId: created.artifactId, decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'profile-creator-a' },
    );
    expect(decision, JSON.stringify(decision)).toMatchObject({
      ok: false, errorCode: 'approval_stale', effectAttempted: false,
    });
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
    await expect(store.approvalsGet({
      artifactId: created.artifactId,
      serverId: 'profile-creator-a',
    })).resolves.toMatchObject({
      status: 'approved',
    });
    const retained = ApprovalRequestSchema.parse(await store.approvalsGet({ artifactId: created.artifactId, serverId: 'profile-creator-a' }));
    expect(retained?.execution).toBeUndefined();
  });
});

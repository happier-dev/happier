import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { z } from 'zod';

import type { Credentials, StoredCredentials } from '@/persistence';
import { decodeBase64, decryptWithDataKey, encodeBase64, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  ApprovalRequestV1Schema,
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  ExecutionRunHostActionApprovalRequestV1Schema,
  TargetActionApprovalRequestV1Schema,
  decodePlainArtifactStoredContent,
  openEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { createCliApprovalsArtifactStore } from './artifactStore';

const { mockGet, mockPost, mockFetchServerFeaturesSnapshot } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockFetchServerFeaturesSnapshot: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: mockGet,
    post: mockPost,
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    apiServerUrl: 'http://127.0.0.1:24599',
  },
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (...args: unknown[]) =>
    mockFetchServerFeaturesSnapshot(...args),
}));

describe('createCliApprovalsArtifactStore', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockFetchServerFeaturesSnapshot.mockReset();
    mockFetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: 2,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
        },
      },
    });
  });

  type DataKeyCredentials = Credentials & Readonly<{
    encryption: Extract<Credentials['encryption'], { type: 'dataKey' }>;
  }>;

  type EncryptedArtifactPayload = Readonly<{
    id: string;
    header: string;
    body: string;
    dataEncryptionKey: string;
  }>;

  function createCredentials(): DataKeyCredentials {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = libsodiumPublicKeyFromSecretKey(machineKey);
    return {
      token: 'token-1',
      encryption: {
        type: 'dataKey',
        publicKey,
        machineKey,
      },
    };
  }

  function createStore(
    credentials: StoredCredentials,
    accountMode: 'plain' | 'e2ee' = 'e2ee',
  ) {
    return createCliApprovalsArtifactStore({
      credentials,
      getAccountEncryptionMode: async () => accountMode,
    });
  }

  it('creates approval requests as encrypted artifacts with an inbox-compatible header', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let capturedCreateBody: any = null;
    mockPost.mockImplementationOnce(async (url: string, body: any) => {
      capturedCreateBody = { url, body };
      return { status: 200, data: { id: body.id } };
    });

    const created = await store.approvalsCreate({ request, serverId: null });
    expect(created.artifactId).toEqual(expect.any(String));

    expect(capturedCreateBody?.url).toContain('/v1/artifacts');
    const createPayload = capturedCreateBody?.body;
    expect(z.string().uuid().safeParse(createPayload?.id).success).toBe(true);
    expect(typeof createPayload?.header).toBe('string');
    expect(typeof createPayload?.body).toBe('string');
    expect(typeof createPayload?.dataEncryptionKey).toBe('string');

    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(createPayload.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    expect(dataKey).not.toBeNull();
    expect(dataKey?.length).toBe(32);

    const decryptedHeader = decryptWithDataKey(decodeBase64(createPayload.header), dataKey!);
    expect(decryptedHeader).toMatchObject({
      v: 1,
      kind: 'approval_request.v1',
      title: request.summary,
      approvalStatus: request.status,
      actionId: request.actionId,
      sessions: ['s1'],
      sessionId: 's1',
    });

    const decryptedBody = decryptWithDataKey(decodeBase64(createPayload.body), dataKey!);
    expect(decryptedBody).toEqual({ body: JSON.stringify(request) });
  });

  it('creates, reads, lists, and updates plain approval artifacts with token-only credentials', async () => {
    const credentials: StoredCredentials = { token: 'token-only', encryption: null };
    const store = createCliApprovalsArtifactStore({ credentials });
    const open = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockGet.mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await store.approvalsCreate({ request: open, serverId: 'server-1' });

    expect(createdPayload.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
    expect(decodePlainArtifactStoredContent(createdPayload.header)).toMatchObject({
      kind: 'approval_request.v1',
      approvalStatus: 'open',
      serverId: 'server-1',
    });
    expect(decodePlainArtifactStoredContent(createdPayload.body)).toEqual({
      body: JSON.stringify(open),
    });

    const record = (header: string, body: string, version: number) => ({
      id: created.artifactId,
      header,
      headerVersion: version,
      body,
      bodyVersion: version,
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      seq: version,
      createdAt: 1,
      updatedAt: version,
    });
    mockGet.mockResolvedValueOnce({ status: 200, data: record(createdPayload.header, createdPayload.body, 1) });
    await expect(store.approvalsGet({ artifactId: created.artifactId, serverId: 'server-1' }))
      .resolves.toEqual(open);

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: [record(createdPayload.header, createdPayload.body, 1)],
    });
    await expect(store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' }))
      .resolves.toMatchObject({
        items: [{ artifactId: created.artifactId, status: 'open', serverId: 'server-1' }],
      });

    const approved = ApprovalRequestV1Schema.parse({
      ...open,
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    mockGet.mockResolvedValueOnce({ status: 200, data: record(createdPayload.header, createdPayload.body, 1) });
    let updatedPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      updatedPayload = body;
      return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
    });

    await expect(store.approvalsUpdate({
      artifactId: created.artifactId,
      request: approved,
      serverId: 'server-1',
    })).resolves.toEqual({ ok: true });
    expect(decodePlainArtifactStoredContent(updatedPayload.header)).toMatchObject({
      approvalStatus: 'approved',
    });
    expect(decodePlainArtifactStoredContent(updatedPayload.body)).toEqual({
      body: JSON.stringify(approved),
    });

    const artifactGets = mockGet.mock.calls.filter(([url]) =>
      String(url).includes('/v1/artifacts'));
    const artifactPosts = mockPost.mock.calls.filter(([url]) =>
      String(url).includes('/v1/artifacts'));
    expect(artifactGets).toHaveLength(3);
    expect(artifactPosts).toHaveLength(2);
    for (const [, config] of artifactGets) {
      expect(config).toMatchObject({
        headers: {
          'x-happier-account-stored-content-protocol': String(
            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
          ),
        },
      });
    }
    for (const [, , config] of artifactPosts) {
      expect(config).toMatchObject({
        headers: {
          'x-happier-account-stored-content-protocol': String(
            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
          ),
        },
      });
    }
  });

  it('uses the existing artifact route and codec for cancellable prompt-library storage', async () => {
    const store = createStore(createCredentials(), 'e2ee');
    const signal = new AbortController().signal;
    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any, config: any) => {
      expect(config.signal).toBe(signal);
      createdPayload = body;
      return { status: 200, data: { id: body.id } };
    });

    const artifactId = await store.promptLibraryStore.create!({
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' },
      body: JSON.stringify({ v: 1, markdown: '# Prompt', createdAtMs: 1, updatedAtMs: 1 }),
      signal,
    });
    const record = {
      id: artifactId,
      header: createdPayload.header,
      headerVersion: 1,
      body: createdPayload.body,
      bodyVersion: 1,
      dataEncryptionKey: createdPayload.dataEncryptionKey,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    mockGet.mockResolvedValueOnce({ status: 200, data: record });
    await expect(store.promptLibraryStore.read(artifactId, { signal })).resolves.toEqual({
      id: artifactId,
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' },
      body: JSON.stringify({ v: 1, markdown: '# Prompt', createdAtMs: 1, updatedAtMs: 1 }),
    });

    mockGet.mockResolvedValueOnce({ status: 200, data: record });
    mockPost.mockResolvedValueOnce({ status: 200, data: { success: true } });
    await expect(store.promptLibraryStore.update({
      artifactId,
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Updated' },
      body: JSON.stringify({ v: 1, markdown: '# Updated', createdAtMs: 1, updatedAtMs: 2 }),
      signal,
    })).resolves.toBeUndefined();
    expect(mockGet.mock.calls.at(-1)?.[1]?.signal).toBe(signal);
    expect(mockPost.mock.calls.at(-1)?.[2]?.signal).toBe(signal);
  });

  it('refuses a plain approval Artifact create before POST on an immutable old-server capability snapshot', async () => {
    const credentials: StoredCredentials = { token: 'token-only', encryption: null };
    const store = createStore(credentials, 'plain');
    mockFetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          encryption: {
            storagePolicy: 'optional',
          },
        },
      },
    });
    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Do not send',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    await expect(store.approvalsCreate({ request, serverId: null })).rejects.toMatchObject({
      code: 'client-upgrade-required',
      retryable: false,
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('durably creates and reads a truthful target-action approval artifact', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' }, generation: '7',
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let payload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { payload = body; return { status: 200, data: { id: body.id } }; });
    const created = await store.targetActionApprovalsCreate({ request });
    const serializedTransport = JSON.stringify(payload);
    expect(serializedTransport).not.toContain(request.qualifiedActionId);
    expect(serializedTransport).not.toContain(request.summary);
    expect(serializedTransport).not.toContain(request.subjectFingerprint);
    expect(serializedTransport).not.toContain('"value":"x"');
    mockGet.mockImplementationOnce(async () => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: 1, body: payload.body, bodyVersion: 1,
      dataEncryptionKey: payload.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    } }));
    await expect(store.targetActionApprovalsGet({ artifactId: created.artifactId })).resolves.toEqual(request);
    const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(payload.dataEncryptionKey), recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey });
    expect(decryptWithDataKey(decodeBase64(payload.header), key!)).toMatchObject({
      kind: 'target_action_approval.v1', qualifiedActionId: request.qualifiedActionId,
      subjectFingerprint: request.subjectFingerprint,
    });
  });

  it('durably creates, reads, and updates an execution-run host-action approval artifact', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'execution_run_host_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
      actionId: 'reviews.comments.create', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
      profileId: 'acme.review/review', pluginId: 'acme.review', agentId: 'claude', projectId: 'project-1',
      workspaceId: 'workspace-1', serverId: 'server-1',
      proposalCount: 1,
      proposalPreview: [{
        pathLabel: 'src/a.ts', pathSha256: 'b'.repeat(64), startLine: 3, endLine: 3,
        bodySha256: 'c'.repeat(64), bodyPreview: 'Fix this.',
      }],
      subjectFingerprint: 'a'.repeat(64), summary: 'Create 1 proposed review comment',
    });
    let openPayload: EncryptedArtifactPayload | null = null;
    let approvedPayload: EncryptedArtifactPayload | null = null;
    mockPost.mockImplementationOnce(async (_url: string, body: unknown) => {
      const payload = body as EncryptedArtifactPayload;
      openPayload = payload;
      return { status: 200, data: { id: payload.id } };
    });
    const created = await store.executionRunHostActionApprovalsCreate({ request });
    const fullRecord = (payload: EncryptedArtifactPayload, version: number) => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: version,
      body: payload.body, bodyVersion: version, dataEncryptionKey: openPayload!.dataEncryptionKey,
      seq: version, createdAt: 1, updatedAt: version,
    } });
    mockGet.mockImplementationOnce(async () => fullRecord(openPayload!, 1));
    await expect(store.executionRunHostActionApprovalsGet({ artifactId: created.artifactId }))
      .resolves.toEqual(request);

    const approved = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    mockGet.mockImplementationOnce(async () => fullRecord(openPayload!, 1));
    mockPost.mockImplementationOnce(async (_url: string, body: unknown) => {
      approvedPayload = body as EncryptedArtifactPayload;
      return { status: 200, data: { success: true } };
    });
    await expect(store.executionRunHostActionApprovalsUpdate({ artifactId: created.artifactId, request: approved }))
      .resolves.toEqual({ ok: true });

    mockGet.mockImplementationOnce(async () => fullRecord(approvedPayload!, 2));
    await expect(store.executionRunHostActionApprovalsGet({ artifactId: created.artifactId }))
      .resolves.toEqual(approved);
    const key = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(openPayload!.dataEncryptionKey),
      recipientSecretKeyOrSeed: credentials.encryption.machineKey,
    });
    expect(decryptWithDataKey(decodeBase64(openPayload!.header), key!)).toMatchObject({
      kind: 'execution_run_host_action_approval.v1', actionId: 'reviews.comments.create',
      sessionId: 'session-1', runId: 'run-1', subjectFingerprint: request.subjectFingerprint,
    });
  });

  it('keeps execution-run host-action artifacts out of the built-in approval request queue', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'execution_run_host_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
      actionId: 'reviews.comments.create', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
      profileId: 'acme.review/review', pluginId: 'acme.review', agentId: 'claude', projectId: 'project-1',
      workspaceId: 'workspace-1', serverId: 'server-1', proposalCount: 1,
      proposalPreview: [{
        pathLabel: 'a.ts', pathSha256: 'a'.repeat(64), bodySha256: 'b'.repeat(64), bodyPreview: 'Fix this.',
      }],
      subjectFingerprint: 'c'.repeat(64), summary: 'Create 1 proposed review comment',
    });
    let payload: Readonly<{ id: string; header: string; dataEncryptionKey: string }> | null = null;
    mockPost.mockImplementationOnce(async (_url: string, body: unknown) => {
      const record = body as Readonly<{ id: string; header: string; dataEncryptionKey: string }>;
      payload = record;
      return { status: 200, data: { id: record.id } };
    });
    await store.executionRunHostActionApprovalsCreate({ request });
    mockGet.mockResolvedValueOnce({ status: 200, data: [{
      id: payload!.id, header: payload!.header, headerVersion: 1,
      dataEncryptionKey: payload!.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    }] });

    await expect(store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' }))
      .resolves.toMatchObject({ items: [] });
  });

  it('rejects a target-action decision update that mutates the approved subject', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' }, generation: '7',
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let payload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { payload = body; return { status: 200, data: { id: body.id } }; });
    const created = await store.targetActionApprovalsCreate({ request });
    mockGet.mockImplementationOnce(async () => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: 1, body: payload.body, bodyVersion: 1,
      dataEncryptionKey: payload.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    } }));
    const mutated = TargetActionApprovalRequestV1Schema.parse({
      ...request, generation: '8', status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: mutated }))
      .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('persists an approved target action through one idempotent terminal execution transition', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const open = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' }, generation: '7',
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let createdPayload: any;
    let approvedPayload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { createdPayload = body; return { status: 200, data: { id: body.id } }; });
    const created = await store.targetActionApprovalsCreate({ request: open });
    const fullRecord = (payload: any, version: number) => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: version,
      body: payload.body, bodyVersion: version, dataEncryptionKey: createdPayload.dataEncryptionKey,
      seq: version, createdAt: 1, updatedAt: version,
    } });
    mockGet.mockImplementationOnce(async () => fullRecord(createdPayload, 1));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { approvedPayload = body; return { status: 200, data: { success: true } }; });
    const approved = TargetActionApprovalRequestV1Schema.parse({
      ...open, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: approved }))
      .resolves.toEqual({ ok: true });

    let executedPayload: any;
    const executed = TargetActionApprovalRequestV1Schema.parse({
      ...approved,
      status: 'executed',
      updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: true, result: { published: true } },
    });
    mockGet.mockImplementationOnce(async () => fullRecord(approvedPayload, 2));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      executedPayload = body;
      return { status: 200, data: { success: true } };
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executed }))
      .resolves.toEqual({ ok: true });

    mockGet.mockImplementationOnce(async () => fullRecord(executedPayload, 3));
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executed }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(3);

    mockGet.mockImplementationOnce(async () => fullRecord(executedPayload, 3));
    const rejected = TargetActionApprovalRequestV1Schema.parse({
      ...open, status: 'rejected', updatedAtMs: 4, decision: { kind: 'reject', decidedAtMs: 4 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: rejected }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost).toHaveBeenCalledTimes(3);
  });

  it('reads approval requests by decrypting artifact bodies', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    const storeCreate = createStore(credentials);
    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await storeCreate.approvalsCreate({ request, serverId: null });

    mockGet.mockImplementationOnce(async (url: string) => {
      expect(url).toContain(`/v1/artifacts/${encodeURIComponent(created.artifactId)}`);
      return {
        status: 200,
        data: {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          body: createdPayload.body,
          bodyVersion: 1,
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    });

    const read = await store.approvalsGet({ artifactId: created.artifactId, serverId: null });
    expect(read).toEqual(request);
  });

  it('distinguishes a retained encrypted approval from a missing artifact for token-only credentials', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const retainedArtifact = {
      id: 'retained-approval',
      header: 'retained-encrypted-header',
      headerVersion: 2,
      body: 'retained-encrypted-body',
      bodyVersion: 4,
      dataEncryptionKey: 'retained-encrypted-data-key',
      seq: 3,
      createdAt: 1,
      updatedAt: 2,
    };

    mockGet.mockResolvedValueOnce({ status: 200, data: retainedArtifact });
    await expect(store.approvalsGet({
      artifactId: retainedArtifact.id,
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });

    mockGet.mockResolvedValueOnce({ status: 404, data: { error: 'not_found' } });
    await expect(store.approvalsGet({
      artifactId: 'missing-approval',
      serverId: null,
    })).resolves.toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it.each([
    ['header', true],
    ['body', false],
  ] as const)('fails typed when a retained plain approval has a malformed %s envelope', async (_field, corruptHeader) => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });
    const malformedPlainEnvelope = encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain' })),
      'base64',
    );
    const validHeader = encodeBase64(
      new TextEncoder().encode(JSON.stringify({
        t: 'plain',
        v: {
          v: 1,
          kind: 'approval_request.v1',
          title: request.summary,
          approvalStatus: request.status,
          actionId: request.actionId,
        },
      })),
      'base64',
    );
    const validBody = encodeBase64(
      new TextEncoder().encode(JSON.stringify({
        t: 'plain',
        v: { body: JSON.stringify(request) },
      })),
      'base64',
    );

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'malformed-plain-approval',
        header: corruptHeader ? malformedPlainEnvelope : validHeader,
        headerVersion: 1,
        body: corruptHeader ? validBody : malformedPlainEnvelope,
        bodyVersion: 1,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(store.approvalsGet({
      artifactId: 'malformed-plain-approval',
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fails typed instead of reporting absence when the Artifact API cannot open retained content', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');

    mockGet.mockResolvedValueOnce({
      status: 500,
      data: { error: 'Failed to get artifact' },
    });
    await expect(store.approvalsGet({
      artifactId: 'unavailable-approval',
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });

    mockGet.mockResolvedValueOnce({
      status: 500,
      data: { error: 'Failed to get artifacts' },
    });
    await expect(store.approvalsList({
      status: 'open',
      limit: 10,
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fails a retained encrypted approval list with typed locked state instead of omitting the row', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: [{
        id: 'retained-approval',
        header: 'retained-encrypted-header',
        headerVersion: 2,
        dataEncryptionKey: 'retained-encrypted-data-key',
        seq: 3,
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    await expect(store.approvalsList({
      status: 'open',
      limit: 10,
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('lists approval queue items from encrypted artifact headers without reading artifact bodies', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-1' });

    mockGet.mockImplementationOnce(async (url: string) => {
      expect(url).toContain('/v1/artifacts');
      expect(url).toContain('limit=50');
      return {
        status: 200,
        data: [
          {
            id: created.artifactId,
            header: createdPayload.header,
            headerVersion: 1,
            dataEncryptionKey: createdPayload.dataEncryptionKey,
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      };
    });

    const listed = await store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' });

    expect(listed).toEqual({
      items: [
        {
          artifactId: created.artifactId,
          status: 'open',
          actionId: 'session.message.send',
          summary: 'Approve sending a message',
          sessionId: 's1',
          serverId: 'server-1',
          updatedAtMs: 2,
        },
      ],
      queryPlan: {
        kind: 'bounded_approval_artifact_header_scan',
        backingStore: 'ArtifactStore',
        boundedBy: 'GET /v1/artifacts?limit=50',
        serverLimit: 50,
        hydratedTranscripts: false,
      },
    });
  });

  it('excludes unscoped approval artifacts from server-scoped list queries', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await store.approvalsCreate({ request, serverId: null });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: [
        {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    }));

    const listed = await store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' });

    expect(listed.items).toEqual([]);
  });

  it('does not return approval artifacts from another server scope', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-2' });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: {
        id: created.artifactId,
        header: createdPayload.header,
        headerVersion: 1,
        body: createdPayload.body,
        bodyVersion: 1,
        dataEncryptionKey: createdPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }));

    const read = await store.approvalsGet({ artifactId: created.artifactId, serverId: 'server-1' });

    expect(read).toBeNull();
  });

  it('lists canceled approval queue items from encrypted artifact headers', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'canceled',
      summary: 'Canceled send request',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-1' });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: [
        {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    }));

    const listed = await store.approvalsList({ status: 'canceled', limit: 10, serverId: 'server-1' });

    expect(listed.items).toEqual([
      expect.objectContaining({
        artifactId: created.artifactId,
        status: 'canceled',
        actionId: 'session.message.send',
        summary: 'Canceled send request',
        sessionId: 's1',
        serverId: 'server-1',
      }),
    ]);
  });

  it('updates approval artifacts using optimistic versions', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'approved',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });

    // Create a stable on-server artifact record to update.
    const updateStore = createStore(credentials);
    let createPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await updateStore.approvalsCreate({
      request: ApprovalRequestV1Schema.parse({ ...request, status: 'open', updatedAtMs: 1, decision: undefined }),
      serverId: null,
    });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: {
        id: created.artifactId,
        header: createPayload.header,
        headerVersion: 3,
        body: createPayload.body,
        bodyVersion: 4,
        dataEncryptionKey: createPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }));

    let capturedUpdateBody: any = null;
    mockPost.mockImplementationOnce(async (url: string, body: any) => {
      expect(url).toContain(`/v1/artifacts/${encodeURIComponent(created.artifactId)}`);
      capturedUpdateBody = body;
      return { status: 200, data: { success: true, headerVersion: 4, bodyVersion: 5 } };
    });

    const res = await store.approvalsUpdate({ artifactId: created.artifactId, request, serverId: null });
    expect(res).toEqual({ ok: true });

    expect(capturedUpdateBody).toMatchObject({
      expectedHeaderVersion: 3,
      expectedBodyVersion: 4,
    });

    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(createPayload.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    expect(dataKey).not.toBeNull();

    const decryptedHeader = decryptWithDataKey(decodeBase64(capturedUpdateBody.header), dataKey!);
    expect(decryptedHeader).toMatchObject({
      kind: 'approval_request.v1',
      approvalStatus: 'approved',
      title: request.summary,
      actionId: request.actionId,
    });

    const decryptedBody = decryptWithDataKey(decodeBase64(capturedUpdateBody.body), dataKey!);
    expect(decryptedBody).toEqual({ body: JSON.stringify(request) });
  });

  it('rejects updates to approval artifacts from another server scope', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'approved',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });

    let createPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await store.approvalsCreate({
      request: ApprovalRequestV1Schema.parse({ ...request, status: 'open', updatedAtMs: 1, decision: undefined }),
      serverId: 'server-2',
    });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: {
        id: created.artifactId,
        header: createPayload.header,
        headerVersion: 3,
        body: createPayload.body,
        bodyVersion: 4,
        dataEncryptionKey: createPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }));
    mockPost.mockImplementationOnce(async () => ({
      status: 200,
      data: { success: true, headerVersion: 4, bodyVersion: 5 },
    }));

    const res = await store.approvalsUpdate({ artifactId: created.artifactId, request, serverId: 'server-1' });

    expect(res).toEqual({ ok: false, errorCode: 'not_found', error: 'artifact_not_found' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { z } from 'zod';

import type { Credentials, StoredCredentials } from '@/persistence';
import { decodeBase64, decryptWithDataKey, encryptWithDataKey, encodeBase64, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  API_TOKEN_FULL_GRANT_V1,
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  ExecutionRunHostActionApprovalRequestV1Schema,
  TargetActionApprovalRequestV1Schema,
  encodePlainArtifactStoredContent,
  decodePlainArtifactStoredContent,
  openEncryptedDataKeyEnvelopeV1,
  updatePromptDocInLibrary,
  createPromptDocInLibrary,
  setPromptDocFavorite,
  listPromptLibrary,
} from '@happier-dev/protocol';

import { createCliApprovalsArtifactStore } from './artifactStore';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

const fixtureArtifacts = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('axios', () => ({
  default: {
    get: vi.fn(async (url: string, config?: unknown) => {
      if (url.endsWith('/recipients')) {
        const artifactId = decodeURIComponent(url.split('/').at(-3) ?? '');
        const artifact = fixtureArtifacts.get(artifactId);
        if (!artifact) throw new Error('Missing Artifact HTTP census fixture');
        return { status: 200, data: { artifactId, ownerAccountId: artifact.ownerAccountId,
          access: artifact.access, encryptionMode: artifact.encryptionMode,
          dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] } };
      }
      const response = await mockGet(url, config);
      const rows: unknown[] = Array.isArray(response?.data) ? response.data : [response?.data];
      for (const row of rows) {
        if (row && typeof row === 'object' && typeof Reflect.get(row, 'id') === 'string') {
          fixtureArtifacts.set(Reflect.get(row, 'id'), row as Record<string, unknown>);
        }
      }
      return response;
    }),
    post: mockPost,
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    apiServerUrl: 'http://127.0.0.1:24599',
  },
}));

describe('createCliApprovalsArtifactStore', () => {
  it('refuses a prompt update based on an earlier read instead of overwriting a concurrent writer', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    let record = {
      id: 'prompt-race', ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Original' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'original', createdAtMs: 1, updatedAtMs: 1 }) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    };
    const concurrent = { ...record, headerVersion: 2, bodyVersion: 2,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Concurrent' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'concurrent', createdAtMs: 1, updatedAtMs: 2 }) }),
    };
    mockGet.mockImplementation(async () => ({ status: 200, data: record }));
    mockPost.mockImplementation(async (_url: string, input: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number }) => {
      if (input.expectedHeaderVersion !== record.headerVersion || input.expectedBodyVersion !== record.bodyVersion) {
        return { status: 200, data: { success: false, error: 'version-mismatch' } };
      }
      record = { ...record, header: input.header, body: input.body, headerVersion: 3, bodyVersion: 3 };
      return { status: 200, data: { success: true, headerVersion: 3, bodyVersion: 3 } };
    });
    await expect(updatePromptDocInLibrary({ store: store.promptLibraryStore,
      request: { artifactId: record.id, title: 'Stale', markdown: 'stale' },
      nowMs: () => { record = concurrent; return 3; },
    })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(record).toEqual(concurrent);
  });
  beforeEach(() => {
    fixtureArtifacts.clear();
    mockGet.mockReset();
    mockPost.mockReset();
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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
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

  it('persists V2 execution provenance at the same approval Artifact owner and binds the header to it', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = ApprovalRequestV2Schema.parse({
      v: 2,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        serverId: 'server-1',
        serverIdentityId: 'stable-home-identity',
        sessionId: 's1',
        target: { kind: 'session', sessionId: 's1' },
        actionId: 'session.message.send',
        requestId: 'request-1',
        machineId: 'machine-1',
        externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'home-signed-invocation-requires-machine-possession',
          binding: {
            serverIdentityId: 'stable-home-identity', accountId: 'account-1', principalId: 'principal-1',
            credentialId: 'credential-1', machineId: 'machine-1',
            grant: API_TOKEN_FULL_GRANT_V1,
            actionId: 'session.message.send', requestId: 'request-1',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'session', sessionId: 's1' },
          },
        },
      },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });
    let capturedCreateBody: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      capturedCreateBody = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });

    await store.approvalsCreate({ request, serverId: 'server-1' });
    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(capturedCreateBody.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    const header = decryptWithDataKey(decodeBase64(capturedCreateBody.header), dataKey!);
    const body = decryptWithDataKey(decodeBase64(capturedCreateBody.body), dataKey!);
    expect(header).toMatchObject({
      kind: 'approval_request.v1',
      actionId: 'session.message.send',
      serverId: 'server-1',
      serverIdentityId: 'stable-home-identity',
      sessionId: 's1',
    });
    expect(body).toEqual({ body: JSON.stringify(request) });
    mockGet.mockResolvedValue({ status: 200, data: {
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      ...capturedCreateBody, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodeBase64(encryptWithDataKey({ ...(header as Record<string, unknown>), serverIdentityId: 'wrong-home' }, dataKey!)),
    } });
    await expect(store.approvalsGet({ artifactId: capturedCreateBody.id, serverId: 'server-1' })).resolves.toBeNull();

    mockGet.mockResolvedValueOnce({ status: 200, data: {
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      ...capturedCreateBody, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodeBase64(encryptWithDataKey({
        ...(header as Record<string, unknown>),
        serverIdentityId: ' stable-home-identity ',
      }, dataKey!)),
    } });
    await expect(store.approvalsGet({ artifactId: capturedCreateBody.id, serverId: 'server-1' })).resolves.toBeNull();
    await expect(store.approvalsCreate({ request, serverId: 'server-2' }))
      .rejects.toThrow('approval_request_server_target_mismatch');

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        id: capturedCreateBody.id,
        header: capturedCreateBody.header,
        headerVersion: 1,
        body: capturedCreateBody.body,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: capturedCreateBody.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    mockPost.mockClear();
    const mutatedOrigin = ApprovalRequestV2Schema.parse({
      ...request,
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: {
        ...request.executionOriginV1,
        externalActionExecutionAuthorization: {
          ...request.executionOriginV1.externalActionExecutionAuthorization!,
          token: 'substituted-home-authorization',
        },
      },
    });
    await expect(store.approvalsUpdate({
      artifactId: capturedCreateBody.id,
      request: mutatedOrigin,
      serverId: 'server-1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'subject_mismatch',
      error: 'approval_request_subject_mismatch',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('permits only the released V1 approved-to-stale tombstone transition', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const approved = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.title.set',
      status: 'approved',
      summary: 'Set title',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system', sessionId: 'session-1' },
      actionArgs: { sessionId: 'session-1', title: 'Legacy' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    const terminal = ApprovalRequestV1Schema.parse({
      ...approved,
      status: 'failed',
      updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: false, errorCode: 'approval_stale', error: 'approval_stale' },
    });
    let createdPayload: EncryptedArtifactPayload | null = null;
    mockPost.mockImplementationOnce(async (_url: string, body: EncryptedArtifactPayload) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request: approved, serverId: null });
    mockPost.mockClear();
    // approvalsUpdate reads once to validate the transition and once more to
    // preserve the existing encrypted data key while performing the CAS.
    mockGet.mockResolvedValue({ status: 200, data: {
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      ...createdPayload!,
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
    } });

    mockPost.mockImplementationOnce(async () => ({
      status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 },
    }));
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: terminal, serverId: null }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledOnce();

    const nonStaleFailure = ApprovalRequestV1Schema.parse({
      ...approved,
      status: 'failed',
      updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: false, errorCode: 'action_disabled', error: 'action_disabled' },
    });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: nonStaleFailure, serverId: null }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
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
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      seq: version,
      createdAt: 1,
      updatedAt: version,
    });
    mockGet.mockResolvedValueOnce({ status: 200, data: record(createdPayload.header, createdPayload.body, 1) });
    await expect(store.approvalsGet({ artifactId: created.artifactId, serverId: 'server-1' }))
      .resolves.toEqual(open);

    mockGet
      .mockResolvedValueOnce({
        status: 200,
        data: [record(createdPayload.header, createdPayload.body, 1)],
      })
      .mockResolvedValueOnce({
        status: 200,
        data: record(createdPayload.header, createdPayload.body, 1),
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
    mockGet
      .mockResolvedValueOnce({ status: 200, data: record(createdPayload.header, createdPayload.body, 1) })
      .mockResolvedValueOnce({ status: 200, data: record(createdPayload.header, createdPayload.body, 1) });
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
    expect(artifactGets).toHaveLength(5);
    expect(artifactPosts).toHaveLength(2);
    for (const [, config] of artifactGets) {
      expect(config).toMatchObject({
        headers: {
          Authorization: 'Bearer token-only',
        },
      });
    }
    for (const [, , config] of artifactPosts) {
      expect(config).toMatchObject({
        headers: {
          Authorization: 'Bearer token-only',
        },
      });
    }
  });

  it('serializes invitation approval custody with only the Account-bound continuation', async () => {
    const invitationToken = 'invitation-bearer-must-never-enter-the-artifact';
    const request = ApprovalRequestV2Schema.parse({
      v: 2,
      actionId: 'teams.invitations.accept',
      status: 'open',
      summary: 'Accept Team invitation',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'cli',
        caller: { kind: 'host' },
        serverId: 'home-1',
        actionId: 'teams.invitations.accept',
        requestId: 'request-invitation-1',
      },
      actionArgs: {
        v: 1,
        continuation: {
          v: 1,
          kind: 'post_auth_invitation',
          reference: 'prepared-continuation-reference',
          teamId: 'team-1',
        },
      },
      preview: {
        actionId: 'teams.invitations.accept',
        actionArgs: {
          homeServerId: 'home-1',
          continuation: { teamId: 'team-1' },
          teamName: 'Platform',
        },
      },
    });
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });

    await store.approvalsCreate({ request, serverId: 'home-1' });

    const serializedBody = decodePlainArtifactStoredContent(createdPayload.body);
    expect(serializedBody).toEqual({ body: JSON.stringify(request) });
    expect(JSON.stringify(serializedBody)).toContain('prepared-continuation-reference');
    expect(JSON.stringify(serializedBody)).not.toContain(invitationToken);
  });

  it.each(['plain', 'e2ee'] as const)('creates and favourites prompts through the real %s Artifact adapter', async (mode) => {
    const store = createStore(mode === 'plain' ? { token: 'token-only', encryption: null } : createCredentials(), mode);
    const signal = new AbortController().signal;
    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any, config: any) => {
      expect(config.signal).toBe(signal);
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });

    const { artifactId } = await createPromptDocInLibrary({ store: store.promptLibraryStore,
      request: { title: 'Prompt', markdown: '# Prompt', folderId: 'folder', tags: ['topic'] },
      signal, nowMs: () => 1,
    });
    const record = {
      id: artifactId,
      header: createdPayload.header,
      headerVersion: 1,
      body: createdPayload.body,
      bodyVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: mode,
      dataEncryptionKey: createdPayload.dataEncryptionKey,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    mockGet.mockResolvedValueOnce({ status: 200, data: record });
    await expect(store.promptLibraryStore.read(artifactId, { signal })).resolves.toMatchObject({
      id: artifactId,
      revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' },
      body: JSON.stringify({ v: 1, markdown: '# Prompt', createdAtMs: 1, updatedAtMs: 1 }),
    });

    mockGet
      .mockResolvedValueOnce({ status: 200, data: record })
      .mockResolvedValueOnce({ status: 200, data: record });
    mockPost.mockResolvedValueOnce({ status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } });
    await expect(setPromptDocFavorite({ store: store.promptLibraryStore,
      request: { artifactId, favorite: true }, signal })).resolves.toEqual({ ok: true, artifactId });
    expect(mockGet.mock.calls.at(-1)?.[1]?.signal).toBe(signal);
    expect(mockPost.mock.calls.at(-1)?.[2]?.signal).toBe(signal);
    mockGet.mockResolvedValueOnce({ status: 200, data: [record] });
    await expect(listPromptLibrary({ store: store.promptLibraryStore, request: {} })).resolves.toMatchObject({
      coverage: 'complete', items: [{ artifactId, folderId: 'folder', tags: ['topic'] }],
    });
  });


  it('durably creates and reads a truthful target-action approval artifact', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' },
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let payload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { payload = body; return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } }; });
    const created = await store.targetActionApprovalsCreate({ request });
    const serializedTransport = JSON.stringify(payload);
    expect(serializedTransport).not.toContain(request.qualifiedActionId);
    expect(serializedTransport).not.toContain(request.summary);
    expect(serializedTransport).not.toContain(request.subjectFingerprint);
    expect(serializedTransport).not.toContain('"value":"x"');
    mockGet.mockImplementationOnce(async () => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: 1, body: payload.body, bodyVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
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
      return { status: 200, data: { id: payload.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.executionRunHostActionApprovalsCreate({ request });
    const fullRecord = (payload: EncryptedArtifactPayload, version: number) => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: version,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      body: payload.body, bodyVersion: version, dataEncryptionKey: openPayload!.dataEncryptionKey,
      seq: version, createdAt: 1, updatedAt: version,
    } });
    mockGet.mockImplementationOnce(async () => fullRecord(openPayload!, 1));
    await expect(store.executionRunHostActionApprovalsGet({ artifactId: created.artifactId }))
      .resolves.toEqual(request);

    const approved = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    mockGet
      .mockImplementationOnce(async () => fullRecord(openPayload!, 1))
      .mockImplementationOnce(async () => fullRecord(openPayload!, 1));
    mockPost.mockImplementationOnce(async (_url: string, body: unknown) => {
      approvedPayload = body as EncryptedArtifactPayload;
      return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
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
      return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
    });
    await store.executionRunHostActionApprovalsCreate({ request });
    mockGet.mockResolvedValueOnce({ status: 200, data: [{
      id: payload!.id, header: payload!.header, headerVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
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
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' },
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let payload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { payload = body; return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } }; });
    const created = await store.targetActionApprovalsCreate({ request });
    mockGet.mockImplementationOnce(async () => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: 1, body: payload.body, bodyVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: payload.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    } }));
    const mutated = TargetActionApprovalRequestV1Schema.parse({
      ...request, sourceCustody: { kind: 'development', registeredRootId: 'root-8' }, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: mutated }))
      .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('requires target-action approved→executing→terminal CAS transitions', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const open = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' },
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let createdPayload: any;
    let approvedPayload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { createdPayload = body; return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } }; });
    const created = await store.targetActionApprovalsCreate({ request: open });
    const fullRecord = (payload: any, version: number) => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: version,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      body: payload.body, bodyVersion: version, dataEncryptionKey: createdPayload.dataEncryptionKey,
      seq: version, createdAt: 1, updatedAt: version,
    } });
    mockGet
      .mockImplementationOnce(async () => fullRecord(createdPayload, 1))
      .mockImplementationOnce(async () => fullRecord(createdPayload, 1));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { approvedPayload = body; return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } }; });
    const approved = TargetActionApprovalRequestV1Schema.parse({
      ...open, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: approved }))
      .resolves.toEqual({ ok: true });

    const directTerminal = TargetActionApprovalRequestV1Schema.parse({
      ...approved, status: 'executed', updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: true, result: { published: true } },
    });
    mockGet.mockImplementationOnce(async () => fullRecord(approvedPayload, 2));
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: directTerminal }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost).toHaveBeenCalledTimes(2);

    let executingPayload: any;
    const executing = TargetActionApprovalRequestV1Schema.parse({
      ...approved, status: 'executing', updatedAtMs: 3,
    });
    mockGet
      .mockImplementationOnce(async () => fullRecord(approvedPayload, 2))
      .mockImplementationOnce(async () => fullRecord(approvedPayload, 2));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      executingPayload = body;
      return { status: 200, data: { success: true, headerVersion: 3, bodyVersion: 3 } };
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executing }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(3);

    // An executing row proves another caller already won the exclusive claim.
    // Byte-identical claim bytes must not turn that observation into ownership.
    mockGet.mockImplementationOnce(async () => fullRecord(executingPayload, 3));
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executing }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost).toHaveBeenCalledTimes(3);

    let executedPayload: any;
    const executed = TargetActionApprovalRequestV1Schema.parse({
      ...executing,
      status: 'executed',
      updatedAtMs: 4,
      execution: { executedAtMs: 4, ok: true, result: { published: true } },
    });
    mockGet
      .mockImplementationOnce(async () => fullRecord(executingPayload, 3))
      .mockImplementationOnce(async () => fullRecord(executingPayload, 3));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      executedPayload = body;
      return { status: 200, data: { success: true, headerVersion: 4, bodyVersion: 4 } };
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executed }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(4);

    mockGet.mockImplementationOnce(async () => fullRecord(executedPayload, 4));
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executed }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(4);

    mockGet.mockImplementationOnce(async () => fullRecord(executedPayload, 3));
    const rejected = TargetActionApprovalRequestV1Schema.parse({
      ...open, status: 'rejected', updatedAtMs: 4, decision: { kind: 'reject', decidedAtMs: 4 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: rejected }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost).toHaveBeenCalledTimes(4);
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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
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
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
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
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
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
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
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

  it('scans Artifact cursors until it finds the requested matching approval', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const encodedHeader = (value: Record<string, unknown>) => encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })),
      'base64',
    );
    const approval = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve message',
      createdAtMs: 7,
      updatedAtMs: 94,
      createdBy: { surface: 'cli' },
      actionArgs: { sessionId: 'session-1', message: 'hello' },
    });
    const approvalHeader = encodedHeader({
      v: 1,
      kind: 'approval_request.v1',
      title: approval.summary,
      approvalStatus: approval.status,
      actionId: approval.actionId,
      serverId: 'server-1',
    });
    const approvalBody = encodePlainArtifactStoredContent({ body: JSON.stringify(approval) });
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `unrelated-${index}`,
        header: encodedHeader({ v: 1, kind: 'prompt_library_item.v1', title: `Other ${index}` }),
        headerVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: index + 1,
        createdAt: index + 1,
        updatedAt: 100 - index,
      })),
      {
        id: 'approval-after-unrelated',
        header: approvalHeader,
        headerVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 7,
        createdAt: 7,
        updatedAt: 94,
      },
    ];
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/v1/artifacts/approval-after-unrelated')) {
        return {
          status: 200,
          data: {
            id: 'approval-after-unrelated',
            header: approvalHeader,
            headerVersion: 1,
            body: approvalBody,
            bodyVersion: 1,
            ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            seq: 7,
            createdAt: 7,
            updatedAt: 94,
          },
        };
      }
      return { status: 200, data: [rows.shift()] };
    });

    await expect(store.approvalsList({ status: 'open', limit: 1, serverId: 'server-1' }))
      .resolves.toMatchObject({
        items: [{ artifactId: 'approval-after-unrelated', status: 'open', serverId: 'server-1' }],
        queryPlan: { kind: 'approval_artifact_header_scan' },
      });
    expect(mockGet).toHaveBeenCalledTimes(8);
  });

  it('fails a retained encrypted approval list with typed locked state instead of omitting the row', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: [{
        id: 'retained-approval',
        header: 'retained-encrypted-header',
        headerVersion: 2,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
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

  it('lists approval queue items only after the encrypted header and body agree', async () => {
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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-1' });

    mockGet
      .mockImplementationOnce(async (url: string) => {
        expect(url).toContain('/v1/artifacts');
        expect(url).toContain('limit=10');
        return {
          status: 200,
          data: [
            {
              id: created.artifactId,
              header: createdPayload.header,
              headerVersion: 1,
              ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
              dataEncryptionKey: createdPayload.dataEncryptionKey,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          body: createdPayload.body,
          bodyVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
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
        kind: 'approval_artifact_header_scan',
        backingStore: 'ArtifactStore',
        boundedBy: 'ArtifactStore source exhaustion',
        serverLimit: 10,
        hydratedTranscripts: false,
      },
    });
  });

  it('filters list results from the hydrated body-authoritative status, not a stale index row', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const encodeHeader = (value: Record<string, unknown>) => encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })),
      'base64',
    );
    const approved = ApprovalRequestV1Schema.parse({
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
    const staleListHeader = encodeHeader({
      v: 1,
      kind: 'approval_request.v1',
      title: approved.summary,
      approvalStatus: 'open',
      actionId: approved.actionId,
      sessions: ['s1'],
      sessionId: 's1',
      serverId: 'server-1',
    });
    const hydratedHeader = encodeHeader({
      v: 1,
      kind: 'approval_request.v1',
      title: approved.summary,
      approvalStatus: 'approved',
      actionId: approved.actionId,
      sessions: ['s1'],
      sessionId: 's1',
      serverId: 'server-1',
    });
    mockGet
      .mockResolvedValueOnce({
        status: 200,
        data: [{
          id: 'approval-raced',
          header: staleListHeader,
          headerVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 'approval-raced',
          header: hydratedHeader,
          headerVersion: 2,
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(approved) }),
          bodyVersion: 2,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          seq: 2,
          createdAt: 1,
          updatedAt: 2,
        },
      });

    await expect(store.approvalsList({ status: 'approved', limit: 10, serverId: 'server-1' }))
      .resolves.toMatchObject({
        items: [{
          artifactId: 'approval-raced',
          status: 'approved',
          updatedAtMs: 2,
        }],
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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request, serverId: null });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: [
        {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })).mockResolvedValueOnce({
      status: 200,
      data: {
        id: created.artifactId,
        header: createdPayload.header,
        headerVersion: 1,
        body: createdPayload.body,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createdPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    });

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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
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
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createdPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })).mockResolvedValueOnce({
      status: 200,
      data: {
        id: created.artifactId,
        header: createdPayload.header,
        headerVersion: 1,
        body: createdPayload.body,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createdPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    });

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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-1' });

    mockGet
      .mockImplementationOnce(async () => ({
        status: 200,
        data: [
          {
            id: created.artifactId,
            header: createdPayload.header,
            headerVersion: 1,
            ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey: createdPayload.dataEncryptionKey,
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }))
      .mockImplementationOnce(async () => ({
        status: 200,
        data: {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          body: createdPayload.body,
          bodyVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await updateStore.approvalsCreate({
      request: ApprovalRequestV1Schema.parse({ ...request, status: 'open', updatedAtMs: 1, decision: undefined }),
      serverId: null,
    });

    const storedRecord = {
      id: created.artifactId,
      header: createPayload.header,
      headerVersion: 3,
      body: createPayload.body,
      bodyVersion: 4,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: createPayload.dataEncryptionKey,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: storedRecord,
    })).mockImplementationOnce(async () => ({ status: 200, data: storedRecord }));

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

  it('admits the executing claim only for current V2 approvals and only through the artifact revision CAS', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const open = ApprovalRequestV2Schema.parse({
      v: 2,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      requestedSurface: 'mcp',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'mcp',
        caller: { kind: 'host' },
        serverId: 'server-1',
        sessionId: 's1',
        target: { kind: 'session', sessionId: 's1' },
        actionId: 'session.message.send',
        requestId: 'request-1',
      },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });
    const approved = ApprovalRequestV2Schema.parse({
      ...open, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    const executing = ApprovalRequestV2Schema.parse({ ...approved, status: 'executing', updatedAtMs: 3 });
    const executed = ApprovalRequestV2Schema.parse({
      ...approved,
      status: 'executed',
      updatedAtMs: 4,
      execution: { executedAtMs: 4, ok: true, result: { status: 'accepted', localId: 'local-1' } },
    });

    let createPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request: open, serverId: 'server-1' });

    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(createPayload.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    const recordFor = (request: unknown, headerVersion: number, bodyVersion: number) => {
      const header = { ...(decryptWithDataKey(decodeBase64(createPayload.header), dataKey!) as any) };
      header.approvalStatus = (request as { status: string }).status;
      return {
        id: created.artifactId,
        header: encodeBase64(encryptWithDataKey(header, dataKey!)),
        headerVersion,
        body: encodeBase64(encryptWithDataKey({ body: JSON.stringify(request) }, dataKey!)),
        bodyVersion,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createPayload.dataEncryptionKey,
        seq: headerVersion,
        createdAt: 1,
        updatedAt: headerVersion,
      };
    };

    // An open row cannot be claimed: the decision must be committed first.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(open, 1, 1) });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });

    // approved -> executing rides the exact read revision as its CAS precondition.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(approved, 5, 6) });
    let claimBody: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      claimBody = body;
      return { status: 200, data: { success: true, headerVersion: 6, bodyVersion: 7 } };
    });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toEqual({ ok: true });
    expect(claimBody).toMatchObject({ expectedHeaderVersion: 5, expectedBodyVersion: 6 });

    // Exact terminal settlements stay idempotent, but an exact executing row is
    // evidence that this caller did not win the approved -> executing claim.
    mockGet.mockResolvedValueOnce({ status: 200, data: recordFor(executing, 6, 7) });
    const postsBeforeDuplicateClaim = mockPost.mock.calls.length;
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost.mock.calls.length).toBe(postsBeforeDuplicateClaim);

    // A concurrent claimant that lost the server CAS gets a typed version mismatch, not a silent write.
    mockPost.mockImplementationOnce(async () => ({
      status: 200, data: { success: false, error: 'version-mismatch' },
    }));
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch' });

    // executing -> terminal is the only transition an already-claimed row admits.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(executing, 6, 7) });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: approved, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    mockPost.mockImplementationOnce(async () => ({
      status: 200, data: { success: true, headerVersion: 7, bodyVersion: 8 },
    }));
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executed, serverId: 'server-1' }))
      .resolves.toEqual({ ok: true });

    // A duplicate terminal write against the settled row is idempotent, not a second effect.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(executed, 7, 8) });
    const postsBeforeDuplicate = mockPost.mock.calls.length;
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executed, serverId: 'server-1' }))
      .resolves.toEqual({ ok: true });
    expect(mockPost.mock.calls.length).toBe(postsBeforeDuplicate);

    // Released V1 owns no executing state at all, at the schema or the store.
    const legacyApproved = ApprovalRequestV1Schema.parse({
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
    expect(ApprovalRequestV1Schema.safeParse({ ...legacyApproved, status: 'executing' }).success).toBe(false);
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
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
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
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
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

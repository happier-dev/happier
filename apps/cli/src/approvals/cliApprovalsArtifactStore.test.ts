import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { z } from 'zod';

import type { Credentials } from '@/persistence';
import { decodeBase64, decryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { ApprovalRequestV1Schema, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { createCliApprovalsArtifactStore } from './cliApprovalsArtifactStore';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
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

describe('createCliApprovalsArtifactStore', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  function createCredentials(): Credentials {
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

  it('creates approval requests as encrypted artifacts with an inbox-compatible header', async () => {
    const credentials = createCredentials();
    const store = createCliApprovalsArtifactStore({ credentials });

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

  it('reads approval requests by decrypting artifact bodies', async () => {
    const credentials = createCredentials();
    const store = createCliApprovalsArtifactStore({ credentials });

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

    const storeCreate = createCliApprovalsArtifactStore({ credentials });
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

  it('updates approval artifacts using optimistic versions', async () => {
    const credentials = createCredentials();
    const store = createCliApprovalsArtifactStore({ credentials });

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
    const createStore = createCliApprovalsArtifactStore({ credentials });
    let createPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createPayload = body;
      return { status: 200, data: { id: body.id } };
    });
    const created = await createStore.approvalsCreate({
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
});

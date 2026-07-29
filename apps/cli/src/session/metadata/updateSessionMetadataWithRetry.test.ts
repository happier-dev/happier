import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionMetadataEnvelopeFields,
} from './buildSessionMetadataEnvelopeCreateFields';
import {
  openSessionOwnerMetadataV1,
  projectSessionOwnerCompatibilityViewV1,
  readExternalHistoryImportV1FromMetadata,
  readLinkedExternalSessionV1FromMetadata,
  removeLinkedExternalSessionMetadataV1,
} from '@happier-dev/protocol';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  prepareSessionMetadataTuplePatchForTransaction,
  readSessionMetadataTupleWriterSnapshot,
  updateSessionMetadataEnvelopeTupleWithRetry,
  updateSessionMetadataWithRetry,
} from './updateSessionMetadataWithRetry';

const {
  fetchSessionByIdCompatMock,
  patchSessionMetadataEnvelopeTupleMock,
  patchSessionMetadataMock,
} = vi.hoisted(() => ({
  fetchSessionByIdCompatMock: vi.fn(),
  patchSessionMetadataEnvelopeTupleMock: vi.fn(),
  patchSessionMetadataMock: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: fetchSessionByIdCompatMock,
  patchSessionMetadataEnvelopeTuple: patchSessionMetadataEnvelopeTupleMock,
  patchSessionMetadata: patchSessionMetadataMock,
}));

describe('updateSessionMetadataWithRetry', () => {
  beforeEach(() => {
    fetchSessionByIdCompatMock.mockReset();
    patchSessionMetadataEnvelopeTupleMock.mockReset();
    patchSessionMetadataMock.mockReset();
  });

  it('exposes layout-1 owner state through the canonical discriminated tuple value', () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(23),
      },
    };
    const metadata = {
      path: '/private/layout-1',
      host: 'owner-host',
      summary: { text: 'Shared title', updatedAt: 1 },
    };
    const agentState = { requests: { pending: { createdAt: 1 } } };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata,
      agentState,
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });

    const snapshot = readSessionMetadataTupleWriterSnapshot({
      credentials,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 7,
        ownerMetadata: fields.ownerMetadata.ciphertext,
        agentState: fields.agentState,
        agentStateVersion: 3,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
    });

    expect(snapshot).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      metadataVersion: 7,
      agentStateVersion: 3,
      value: {
        metadata,
        sharedMetadata: expect.objectContaining({
          summary: metadata.summary,
        }),
        ownerMetadata: expect.objectContaining({
          workspace: {
            path: metadata.path,
            host: metadata.host,
          },
        }),
        agentState,
      },
    });
    expect(snapshot).not.toHaveProperty('metadata');
    expect(snapshot).not.toHaveProperty('sharedMetadata');
    expect(snapshot).not.toHaveProperty('ownerMetadata');
    expect(snapshot).not.toHaveProperty('agentState');
  });

  it('prepares an encrypted owner tuple replacement without committing it', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(24),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata: {
        path: '/private/external',
        host: 'owner-host',
        externalSessionV1: {
          v: 1,
          agentId: 'example',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          linkedAtMs: 10,
          source: { kind: 'jsonl' },
        },
        directSessionV1: {
          v: 1,
          providerId: 'example',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          linkedAtMs: 10,
          source: { kind: 'jsonl' },
        },
      },
      agentState: null,
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });

    const patch = await prepareSessionMetadataTuplePatchForTransaction({
      credentials,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 7,
        ownerMetadata: fields.ownerMetadata.ciphertext,
        agentState: fields.agentState,
        agentStateVersion: 3,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...removeLinkedExternalSessionMetadataV1(metadata),
        externalHistoryImportV1: {
          v: 1,
          agentId: 'example',
          remoteSessionId: 'remote-1',
          importedAtMs: 100,
          source: { kind: 'jsonl' },
        },
      }),
    });

    expect(patch).toMatchObject({
      mode: 'owner',
      expectedOwnerMetadataCiphertext: fields.ownerMetadata.ciphertext,
      sharedMetadata: { expectedVersion: 7 },
      agentState: { expectedVersion: 3, ciphertext: null },
    });
    if (patch.mode !== 'owner') {
      throw new Error('expected owner tuple replacement');
    }
    const ownerMetadata = openSessionOwnerMetadataV1({
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      ciphertext: patch.ownerMetadata.ciphertext,
    });
    expect(ownerMetadata).not.toBeNull();
    const compatibility = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: JSON.parse(patch.sharedMetadata.ciphertext),
      ownerMetadata: ownerMetadata!,
    });
    expect(readLinkedExternalSessionV1FromMetadata(compatibility)).toBeNull();
    expect(readExternalHistoryImportV1FromMetadata(compatibility)).toEqual({
      v: 1,
      agentId: 'example',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'jsonl' },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('keeps an ordinary layout-0 metadata mutation on the legacy PATCH owner', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(31),
      },
    };
    const sourceMetadata = {
      path: '/legacy',
      host: 'owner',
      summary: { text: 'Before', updatedAt: 1 },
    };
    patchSessionMetadataMock.mockResolvedValue({
      success: true,
      version: 5,
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_ordinary',
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(sourceMetadata),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (current) => ({
        ...current,
        summary: { text: 'After', updatedAt: 2 },
      }),
      maxAttempts: 1,
    });

    expect(result).toEqual({
      version: 5,
      metadata: {
        ...sourceMetadata,
        summary: { text: 'After', updatedAt: 2 },
      },
    });
    expect(patchSessionMetadataMock).toHaveBeenCalledWith({
      token: 'token-1',
      sessionId: 'sess_layout0_ordinary',
      ciphertext: JSON.stringify({
        ...sourceMetadata,
        summary: { text: 'After', updatedAt: 2 },
      }),
      expectedVersion: 4,
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('propagates the inactive-model-intent expectation through layout 0 and does not retry an active conflict', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(33),
      },
    };
    patchSessionMetadataMock.mockResolvedValue({
      success: false,
      error: 'session_active',
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_conditioned',
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify({
          path: '/legacy',
          host: 'owner',
          model: 'before',
        }),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
      updater: (current) => ({
        ...current,
        model: 'after',
      }),
      maxAttempts: 3,
    })).rejects.toMatchObject({
      code: 'session_active',
      retryable: false,
    });

    expect(patchSessionMetadataMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataMock).toHaveBeenCalledWith({
      token: 'token-1',
      sessionId: 'sess_layout0_conditioned',
      ciphertext: JSON.stringify({
        path: '/legacy',
        host: 'owner',
        model: 'after',
      }),
      expectedVersion: 4,
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('returns an ordinary layout-0 metadata no-op without invoking either writer', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(32),
      },
    };
    const sourceMetadata = {
      host: 'owner',
      path: '/legacy',
    };

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_ordinary_noop',
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(sourceMetadata),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: () => ({
        path: '/legacy',
        host: 'owner',
      }),
    });

    expect(result).toEqual({
      version: 4,
      metadata: sourceMetadata,
    });
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'plain current externalSessionV1',
      mode: 'plain' as const,
      metadata: {
        externalSessionV1: {
          v: 1 as const,
          agentId: 'codex',
          machineId: 'machine-private-current',
          remoteSessionId: 'native-private-current',
          source: { kind: 'codexHome' as const, home: 'user' as const },
        },
      },
      privateSentinel: 'machine-private-current',
    },
    {
      name: 'E2EE released cli-v0.2.1 directSessionV1',
      mode: 'e2ee' as const,
      metadata: {
        directSessionV1: {
          v: 1 as const,
          providerId: 'claude',
          machineId: 'machine-private-v0.2.1',
          remoteSessionId: 'native-private-v0.2.1',
          source: {
            kind: 'claudeConfig' as const,
            configDir: '/private/v0.2.1-claude',
          },
        },
      },
      privateSentinel: 'machine-private-v0.2.1',
    },
  ])('keeps $name metadata updates on the released layout-0 writer while activation is frozen', async ({
    mode,
    metadata,
    privateSentinel,
  }) => {
    const secret = new Uint8Array(32).fill(21);
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret,
      },
    };
    const ctx = {
      encryptionKey: secret,
      encryptionVariant: 'legacy' as const,
    };
    const sourceMetadata = {
      ...metadata,
      summary: { text: 'Before', updatedAt: 1 },
    };
    const sourceAgentState = {
      controlledByUser: true,
      privateAgentSentinel: `${privateSentinel}-agent`,
    };
    const sourceMetadataCiphertext = encryptStoredSessionPayload({
      mode,
      ctx,
      payload: sourceMetadata,
    });
    const sourceAgentStateCiphertext = encryptStoredSessionPayload({
      mode,
      ctx,
      payload: sourceAgentState,
    });
    patchSessionMetadataMock.mockResolvedValue({
      success: true,
      version: 5,
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_migration',
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: sourceMetadataCiphertext,
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: sourceAgentStateCiphertext,
        agentStateVersion: 7,
        encryptionMode: mode,
        dataEncryptionKey: null,
      },
      updater: async (current) => ({
        ...current,
        summary: { text: 'After', updatedAt: 2 },
      }),
      maxAttempts: 1,
    });

    expect(result).toMatchObject({
      version: 5,
      metadata: {
        summary: { text: 'After', updatedAt: 2 },
      },
    });
    expect(patchSessionMetadataMock).toHaveBeenCalledTimes(1);
    const request = patchSessionMetadataMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      token: 'token-1',
      sessionId: 'sess_layout0_migration',
      expectedVersion: 4,
    });
    const updatedMetadata = decryptStoredSessionPayload({
      mode,
      ctx,
      value: request.ciphertext,
    });
    expect(updatedMetadata).toEqual({
      ...sourceMetadata,
      summary: { text: 'After', updatedAt: 2 },
    });
    expect(JSON.stringify(updatedMetadata)).toContain(privateSentinel);
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('retries a linked layout-0 metadata conflict through the released writer while activation is frozen', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(22),
      },
    };
    const linkedMetadata = {
      externalSessionV1: {
        v: 1 as const,
        agentId: 'codex',
        machineId: 'machine-private-current',
        remoteSessionId: 'native-private-current',
        source: { kind: 'codexHome' as const, home: 'user' as const },
      },
      summary: { text: 'Before', updatedAt: 1 },
    };
    const concurrentMetadata = {
      ...linkedMetadata,
      summary: { text: 'Concurrent', updatedAt: 2 },
    };
    patchSessionMetadataMock
      .mockResolvedValueOnce({
        success: false,
        error: 'version-mismatch',
        current: {
          version: 5,
          value: JSON.stringify(concurrentMetadata),
        },
      })
      .mockResolvedValueOnce({
        success: true,
        version: 6,
      });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_linked_conflict',
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(linkedMetadata),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: async (current) => ({
        ...current,
        summary: { text: 'After', updatedAt: 3 },
      }),
      maxAttempts: 2,
    });

    expect(result).toEqual({
      version: 6,
      metadata: {
        ...concurrentMetadata,
        summary: { text: 'After', updatedAt: 3 },
      },
    });
    expect(patchSessionMetadataMock).toHaveBeenCalledTimes(2);
    expect(patchSessionMetadataMock.mock.calls.map(
      ([request]) => request.expectedVersion,
    )).toEqual([4, 5]);
    expect(JSON.parse(
      patchSessionMetadataMock.mock.calls[1]?.[0].ciphertext ?? 'null',
    )).toEqual({
      ...concurrentMetadata,
      summary: { text: 'After', updatedAt: 3 },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('updates layout 1 through one strict owner HTTP tuple without creating or falling back to a socket', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };
    const currentMetadata = {
      path: '/private/before',
      host: 'private-host',
      summary: { text: 'Before', updatedAt: 1 },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata: currentMetadata,
      agentState: { requests: {} },
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 4 },
      ownerMetadata: { version: 4 },
      agentState: { version: 8 },
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_1',
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata.ciphertext,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/after',
        summary: { text: 'After', updatedAt: 2 },
      }),
      maxAttempts: 1,
    });

    expect(result).toEqual({
      version: 4,
      metadata: expect.objectContaining({
        path: '/private/after',
        summary: { text: 'After', updatedAt: 2 },
      }),
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    const request = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0];
    expect(request.patch).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      expectedOwnerMetadataCiphertext: fields.ownerMetadata.ciphertext,
      sharedMetadata: { expectedVersion: 3 },
      agentState: { expectedVersion: 7 },
    });
    expect(request).toMatchObject({
      token: 'token-1',
      sessionId: 'sess_layout_1',
    });
    expect(JSON.parse(request.patch.sharedMetadata.ciphertext)).toMatchObject({
      summary: { text: 'After', updatedAt: 2 },
    });
    expect(openSessionOwnerMetadataV1({
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      ciphertext: request.patch.ownerMetadata.ciphertext,
    })?.workspace?.path).toBe('/private/after');
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('propagates the inactive-model-intent expectation through layout 1 and does not retry an active conflict', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(34),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata: {
        path: '/private/before',
        host: 'private-host',
      },
      agentState: null,
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: false,
      error: 'session_active',
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout1_conditioned',
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata.ciphertext,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/after',
      }),
      maxAttempts: 3,
    })).rejects.toMatchObject({
      code: 'session_active',
      retryable: false,
    });

    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch,
    ).toMatchObject({
      mode: 'owner_inactive_model_intent',
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
    });
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('does not send a layout-1 tuple for a deep-equal metadata update', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(17),
      },
    };
    const currentMetadata = {
      path: '/private/same',
      host: 'same-host',
      summary: { text: 'Same', updatedAt: 1 },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata: currentMetadata,
      agentState: { requests: {} },
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout1_noop',
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata.ciphertext,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        summary: { text: 'Same', updatedAt: 1 },
      }),
    });

    expect(result).toEqual({
      version: 3,
      metadata: expect.objectContaining(currentMetadata),
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('refetches the authoritative layout-1 owner tuple after HTTP 409 before rebuilding the retry', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(9),
      },
    };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata: {
        path: '/private/initial',
        host: 'initial-host',
        summary: { text: 'Initial', updatedAt: 1 },
      },
      agentState: { requests: {} },
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    const authoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata: {
        path: '/private/authoritative',
        host: 'authoritative-host',
        summary: { text: 'Concurrent', updatedAt: 2 },
      },
      agentState: { requests: { concurrent: { createdAt: 2 } } },
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({
        success: false,
        error: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 4 },
        agentState: { version: 6 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        ownerMetadata: { version: 5 },
        agentState: { version: 7 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      id: 'sess_layout_conflict',
      metadataLayoutVersion: 1,
      metadata: authoritative.sharedMetadata.ciphertext,
      metadataVersion: 4,
      ownerMetadata: authoritative.ownerMetadata.ciphertext,
      agentState: authoritative.agentState,
      agentStateVersion: 6,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });

    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_conflict',
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: initial.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: initial.ownerMetadata.ciphertext,
        agentState: initial.agentState,
        agentStateVersion: 5,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        summary: { text: 'Requested', updatedAt: 3 },
      }),
      maxAttempts: 2,
    });

    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    const retry = patchSessionMetadataEnvelopeTupleMock.mock.calls[1]?.[0];
    expect(retry.patch).toMatchObject({
      mode: 'owner',
      expectedOwnerMetadataCiphertext:
        authoritative.ownerMetadata.ciphertext,
      sharedMetadata: { expectedVersion: 4 },
      agentState: { expectedVersion: 6 },
    });
    expect(openSessionOwnerMetadataV1({
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      ciphertext: retry.patch.ownerMetadata.ciphertext,
    })?.workspace).toMatchObject({
      path: '/private/authoritative',
      host: 'authoritative-host',
    });
    expect(JSON.parse(retry.patch.agentState.ciphertext)).toEqual({
      requests: { concurrent: { createdAt: 2 } },
    });
  });

  it('replays through the shared tuple owner when an ambiguous layout-1 write left the exact source unchanged', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(5),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      metadata: { path: '/private', host: 'private-host' },
      agentState: null,
      storedContentMode: 'plain',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    const ambiguous = Object.assign(new Error('request timed out'), {
      code: 'ECONNABORTED',
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 2 },
        agentState: { version: 2 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext,
      metadataVersion: 1,
      ownerMetadata: fields.ownerMetadata.ciphertext,
      agentState: fields.agentState,
      agentStateVersion: 1,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_ambiguous',
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 1,
        ownerMetadata: fields.ownerMetadata.ciphertext,
        agentState: fields.agentState,
        agentStateVersion: 1,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({ ...metadata, path: '/private/after' }),
      maxAttempts: 2,
    })).resolves.toMatchObject({
      version: 2,
      metadata: {
        path: '/private/after',
      },
    });

    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });
});

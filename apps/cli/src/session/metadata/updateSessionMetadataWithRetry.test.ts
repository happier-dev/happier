import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionMetadataEnvelopeFields,
} from './buildSessionMetadataEnvelopeCreateFields';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  openSessionOwnerMetadataEnvelopeV1,
  projectSessionOwnerCompatibilityViewV1,
  readExternalHistoryImportV1FromMetadata,
  readLinkedExternalSessionV1FromMetadata,
  removeLinkedExternalSessionMetadataV1,
  sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  clearSessionStateFieldFromMetadata,
  writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
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
  fetchAccountEncryptionCurrentnessMock,
} = vi.hoisted(() => ({
  fetchSessionByIdCompatMock: vi.fn(),
  patchSessionMetadataEnvelopeTupleMock: vi.fn(),
  patchSessionMetadataMock: vi.fn(),
  fetchAccountEncryptionCurrentnessMock: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: fetchSessionByIdCompatMock,
  patchSessionMetadataEnvelopeTuple: patchSessionMetadataEnvelopeTupleMock,
  patchSessionMetadata: patchSessionMetadataMock,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: fetchAccountEncryptionCurrentnessMock,
}));

const plainCurrentness = {
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
};

function e2eeCurrentness(credentials: Readonly<{
  encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }>;
}>) {
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: {
      type: 'legacy',
      secret: credentials.encryption.secret,
    },
  });
  return {
    mode: 'e2ee' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint:
      convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        snapshot.contentPublicKeyFingerprint,
      ),
    updatedAt: 1,
  };
}

describe('updateSessionMetadataWithRetry', () => {
  beforeEach(() => {
    fetchSessionByIdCompatMock.mockReset();
    patchSessionMetadataEnvelopeTupleMock.mockReset();
    patchSessionMetadataMock.mockReset();
    fetchAccountEncryptionCurrentnessMock.mockReset();
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(plainCurrentness);
  });

  it('exposes layout-1 owner state through the canonical discriminated tuple value', () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const metadata = {
      path: '/private/layout-1',
      host: 'owner-host',
      summary: { text: 'Shared title', updatedAt: 1 },
    };
    const agentState = { requests: { pending: { createdAt: 1 } } };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata,
      agentState,
      storedContentMode: 'plain',
    });

    const snapshot = readSessionMetadataTupleWriterSnapshot({
      credentials,
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 7,
        ownerMetadata: fields.ownerMetadata,
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

  it('prepares a plaintext owner tuple replacement with token-only credentials without committing it', async () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
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
    });

    const patch = await prepareSessionMetadataTuplePatchForTransaction({
      credentials,
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 7,
        ownerMetadata: fields.ownerMetadata,
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
      expectedOwnerMetadata: fields.ownerMetadata,
      ownerMetadata: { t: 'plain' },
      sharedMetadata: { expectedVersion: 7 },
      agentState: { expectedVersion: 3, ciphertext: null },
    });
    if (patch.mode !== 'owner') {
      throw new Error('expected owner tuple replacement');
    }
    const opened = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: patch.ownerMetadata,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('expected plain owner metadata');
    const compatibility = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: JSON.parse(patch.sharedMetadata.ciphertext),
      ownerMetadata: opened.ownerMetadata,
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

  it('prepares an encrypted owner replacement for an E2EE Session from the persisted owner branch', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(25),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/encrypted-transcript',
        host: 'private-host',
        summary: { text: 'Before', updatedAt: 1 },
      },
      agentState: null,
      storedContentMode: 'e2ee',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    const patch = await prepareSessionMetadataTuplePatchForTransaction({
      credentials,
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 7,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 3,
        encryptionMode: 'e2ee',
        dataEncryptionKey: null,
      },
      updater: (current) => ({
        ...current,
        path: '/private/encrypted-transcript-after',
      }),
    });
    expect(patch).toMatchObject({
      mode: 'owner',
      expectedOwnerMetadata: fields.ownerMetadata,
      ownerMetadata: { t: 'encrypted' },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('migrates an ordinary layout-0 metadata mutation through one owner tuple', async () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const sourceMetadata = {
      path: '/legacy',
      host: 'owner',
      summary: { text: 'Before', updatedAt: 1 },
    };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 },
      agentState: { version: 8 },
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_ordinary',
      accountEncryptionCurrentness: plainCurrentness,
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

    expect(result).toMatchObject({
      version: 5,
      metadata: {
        ...sourceMetadata,
        summary: { text: 'After', updatedAt: 2 },
      },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledWith({
      token: 'token-1',
      sessionId: 'sess_layout0_ordinary',
      patch: expect.objectContaining({
        mode: 'owner_migration',
        expectedAccountEncryptionMode: 'plain',
        expectedAccountContentPublicKeyFingerprint: null,
        source: expect.objectContaining({
          metadata: {
            version: 4,
            ciphertext: JSON.stringify(sourceMetadata),
          },
        }),
      }),
    });
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('projects canonical Agent identity while migrating layout-0 without changing local truth', async () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const sourceMetadata = {
      path: '/legacy',
      host: 'owner',
      sessionModelsV1: {
        v: 1 as const,
        agentId: 'opencode',
        updatedAt: 1,
        currentModelId: 'model-1',
        availableModels: [{ id: 'model-1', name: 'Model 1' }],
      },
      runtimeDescriptorV1: {
        v: 1 as const,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'opencode-private',
        },
      },
      forkV1: {
        v: 1 as const,
        parentSessionId: 'parent-session',
        parentCutoffSeqInclusive: 42,
        createdAtMs: 2,
        strategy: 'provider_native',
        agentHint: {
          agentId: 'opencode',
          backendMode: 'server',
          agentSessionId: 'opencode-private',
        },
      },
    };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 },
      agentState: { version: 8 },
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_predecessor_compat',
      accountEncryptionCurrentness: plainCurrentness,
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
        summary: { text: 'Unrelated update', updatedAt: 3 },
      }),
      maxAttempts: 1,
    });

    expect(result.metadata.sessionModelsV1).toMatchObject({
      agentId: 'opencode',
    });
    expect(result.metadata.sessionModelsV1).toHaveProperty(
      'provider',
      'opencode',
    );
    expect(result.metadata).toHaveProperty('agentRuntimeDescriptorV1');
    expect(result.metadata.forkV1).toHaveProperty('providerHint');
    expect(
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch,
    ).toMatchObject({
      mode: 'owner_migration',
      target: {
        ownerMetadata: {
          t: 'plain',
          v: expect.objectContaining({
            runtime: expect.any(Object),
          }),
        },
      },
    });
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('fails closed when a layout-0 migration cannot preserve an inactive-model-intent fence', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(33),
      },
    };
    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_conditioned',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify({
          path: '/legacy',
          host: 'owner',
          summary: { text: 'Before', updatedAt: 1 },
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
        summary: { text: 'After', updatedAt: 2 },
      }),
      maxAttempts: 3,
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });

    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
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
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
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

    expect(result).toMatchObject({
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
  ])('migrates $name metadata through the strict owner tuple', async ({
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
    const cryptoContext = mode === 'plain'
      ? { mode: 'plain' as const, ctx: null }
      : { mode: 'e2ee' as const, ctx };
    const sourceMetadata = {
      ...metadata,
      summary: { text: 'Before', updatedAt: 1 },
    };
    const sourceAgentState = {
      controlledByUser: true,
      privateAgentSentinel: `${privateSentinel}-agent`,
    };
    const sourceMetadataCiphertext = encryptStoredSessionPayload({
      ...cryptoContext,
      payload: sourceMetadata,
    });
    const sourceAgentStateCiphertext = encryptStoredSessionPayload({
      ...cryptoContext,
      payload: sourceAgentState,
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 },
      agentState: { version: 8 },
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_migration',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
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
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    const request =
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0];
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret },
    });
    expect(request).toMatchObject({
      token: 'token-1',
      sessionId: 'sess_layout0_migration',
      patch: {
        mode: 'owner_migration',
        expectedAccountEncryptionMode: 'e2ee',
        expectedAccountContentPublicKeyFingerprint:
          snapshot.contentPublicKeyFingerprint,
        source: {
          metadata: {
            version: 4,
            ciphertext: sourceMetadataCiphertext,
          },
          agentState: {
            version: 7,
            ciphertext: sourceAgentStateCiphertext,
          },
        },
      },
    });
    expect(JSON.stringify(result.metadata)).toContain(privateSentinel);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('fails typed before HTTP when layout-0 migration currentness names different E2EE material', async () => {
    const secret = new Uint8Array(32).fill(27);
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret },
    };
    const sourceMetadataCiphertext = encryptStoredSessionPayload({
      mode: 'e2ee',
      ctx: { encryptionKey: secret, encryptionVariant: 'legacy' },
      payload: { path: '/private/mismatched', host: 'private-host' },
    });
    const differentCredentials = {
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(28),
      },
    };

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_mismatched_currentness',
      accountEncryptionCurrentness: e2eeCurrentness(differentCredentials),
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: sourceMetadataCiphertext,
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'e2ee',
        dataEncryptionKey: null,
      },
      updater: (current) => ({ ...current, path: '/private/after' }),
      maxAttempts: 1,
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('retries a linked layout-0 owner migration after an exact conflict refresh', async () => {
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
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({
        success: false,
        error: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        agentState: { version: 8 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 6 },
        agentState: { version: 8 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(concurrentMetadata),
      metadataVersion: 5,
      ownerMetadata: null,
      agentState: null,
      agentStateVersion: 7,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(
      e2eeCurrentness(credentials),
    );

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_linked_conflict',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
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

    expect(result).toMatchObject({
      version: 6,
      metadata: {
        ...concurrentMetadata,
        summary: { text: 'After', updatedAt: 3 },
      },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls.map(
      ([request]) => request.patch.source.metadata.version,
    )).toEqual([4, 5]);
    expect(fetchSessionByIdCompatMock).toHaveBeenCalledOnce();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('preserves an encrypted layout-1 owner envelope for an E2EE Session update', async () => {
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
      accountEncryptionMode: 'e2ee',
      metadata: currentMetadata,
      agentState: { requests: {} },
      storedContentMode: 'e2ee',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    const encryptedOwnerMetadata = sealSessionOwnerMetadataEnvelopeV1({
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      ownerMetadata: fields.ownerMetadataValue,
      randomBytes: (length) => new Uint8Array(length).fill(41),
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
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: encryptedOwnerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'e2ee',
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
      expectedOwnerMetadata: encryptedOwnerMetadata,
      ownerMetadata: { t: 'encrypted' },
      sharedMetadata: { expectedVersion: 3 },
      agentState: { expectedVersion: 7 },
    });
    expect(request).toMatchObject({
      token: 'token-1',
      sessionId: 'sess_layout_1',
    });
    expect(decryptStoredSessionPayload({
      mode: 'e2ee',
      ctx: {
        encryptionKey: credentials.encryption.secret,
        encryptionVariant: 'legacy',
      },
      value: request.patch.sharedMetadata.ciphertext,
    })).toMatchObject({
      summary: { text: 'After', updatedAt: 2 },
    });
    const openedOwner = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      envelope: request.patch.ownerMetadata,
    });
    expect(openedOwner.ok).toBe(true);
    if (!openedOwner.ok) throw new Error('expected encrypted owner metadata');
    expect(openedOwner.ownerMetadata.workspace?.path).toBe('/private/after');
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('fails typed before HTTP when token-only credentials cannot open the encrypted owner branch', async () => {
    const keyedCredentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(43),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials: keyedCredentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/encrypted-owner',
        host: 'private-host',
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    const encryptedOwnerMetadata = sealSessionOwnerMetadataEnvelopeV1({
      material: {
        type: 'legacy',
        secret: keyedCredentials.encryption.secret,
      },
      ownerMetadata: fields.ownerMetadataValue,
      randomBytes: (length) => new Uint8Array(length).fill(44),
    });

    await expect(updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
      sessionId: 'sess_locked_owner',
      accountEncryptionCurrentness: e2eeCurrentness(keyedCredentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: encryptedOwnerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/after',
      }),
      maxAttempts: 1,
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });

    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
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
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/before',
        host: 'private-host',
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: false,
      error: 'session_active',
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout1_conditioned',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata,
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
      accountEncryptionMode: 'e2ee',
      metadata: currentMetadata,
      agentState: { requests: {} },
      storedContentMode: 'plain',
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout1_noop',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata,
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

  it('follows authoritative owner metadata after HTTP 409', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(9),
      },
    };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/initial',
        host: 'initial-host',
        summary: { text: 'Initial', updatedAt: 1 },
      },
      agentState: { requests: {} },
      storedContentMode: 'plain',
    });
    const authoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/authoritative',
        host: 'authoritative-host',
        summary: { text: 'Concurrent', updatedAt: 2 },
      },
      agentState: { requests: { concurrent: { createdAt: 2 } } },
      storedContentMode: 'plain',
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
      ownerMetadata: authoritative.ownerMetadata,
      agentState: authoritative.agentState,
      agentStateVersion: 6,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(
      e2eeCurrentness(credentials),
    );

    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_conflict',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: initial.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: initial.ownerMetadata,
        agentState: initial.agentState,
        agentStateVersion: 5,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/requested',
        summary: { text: 'Requested', updatedAt: 3 },
      }),
      maxAttempts: 2,
    });

    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    const firstAttempt =
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0];
    const retry = patchSessionMetadataEnvelopeTupleMock.mock.calls[1]?.[0];
    expect(firstAttempt.patch).toMatchObject({
      expectedOwnerMetadata: initial.ownerMetadata,
      ownerMetadata: { t: 'encrypted' },
    });
    expect(retry.patch).toMatchObject({
      mode: 'owner',
      expectedOwnerMetadata: authoritative.ownerMetadata,
      ownerMetadata: { t: 'encrypted' },
      sharedMetadata: { expectedVersion: 4 },
      agentState: { expectedVersion: 6 },
    });
    const openedRetryOwner = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      envelope: retry.patch.ownerMetadata,
    });
    expect(openedRetryOwner.ok).toBe(true);
    if (!openedRetryOwner.ok) throw new Error('expected encrypted retry owner metadata');
    expect(openedRetryOwner.ownerMetadata.workspace).toMatchObject({
      path: '/private/requested',
      host: 'authoritative-host',
    });
    expect(JSON.parse(retry.patch.agentState.ciphertext)).toEqual({
      requests: { concurrent: { createdAt: 2 } },
    });
  });

  async function expectRetiredDisplayTitleMutationStopsBeforeRetry(params: Readonly<{
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    retire: () => void;
    assertCurrent: () => void;
    signal?: AbortSignal;
    expectedCode: string;
  }>) {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata: {
        path: '/private/initial',
        host: 'initial-host',
        summary: { text: 'Before', updatedAt: 1 },
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    const authoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata: {
        path: '/private/authoritative',
        host: 'authoritative-host',
        summary: { text: 'Concurrent', updatedAt: 2 },
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockImplementationOnce(async () => {
        params.retire();
        return {
          success: false,
          error: 'session_metadata_version_conflict',
          metadataLayoutVersion: 1,
          sharedMetadata: { version: 4 },
          agentState: { version: 6 },
        };
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        ownerMetadata: { version: 5 },
        agentState: { version: 7 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      id: 'sess_display_title_conflict',
      metadataLayoutVersion: 1,
      metadata: authoritative.sharedMetadata.ciphertext,
      metadataVersion: 4,
      ownerMetadata: authoritative.ownerMetadata,
      agentState: authoritative.agentState,
      agentStateVersion: 6,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_display_title_conflict',
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: initial.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: initial.ownerMetadata,
        agentState: initial.agentState,
        agentStateVersion: 5,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: params.updater,
      maxAttempts: 2,
      currentness: {
        ...(params.signal ? { signal: params.signal } : {}),
        assertCurrent: params.assertCurrent,
      },
    })).rejects.toMatchObject({ code: params.expectedCode });

    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  }

  it('stops a retired display-title set after its first CAS conflict', async () => {
    const operation = new AbortController();
    const cancellation = Object.assign(
      new Error('Session title mutation was aborted'),
      { code: 'plugin_operation_aborted' },
    );
    await expectRetiredDisplayTitleMutationStopsBeforeRetry({
      updater: (metadata) => writeSessionStateFieldToMetadata(
        metadata,
        'display.title',
        { title: 'Requested', staleBehavior: 'bump-if-value-changed' },
      ),
      retire: () => operation.abort(),
      assertCurrent: () => {
        if (operation.signal.aborted) throw cancellation;
      },
      signal: operation.signal,
      expectedCode: 'plugin_operation_aborted',
    });
  });

  it('stops a retired display-title clear after its first CAS conflict', async () => {
    let current = true;
    const retirement = Object.assign(
      new Error('Session title mutation requires the current plugin invocation'),
      { code: 'plugin_session_display_title_scope_unavailable' },
    );
    await expectRetiredDisplayTitleMutationStopsBeforeRetry({
      updater: (metadata) => clearSessionStateFieldFromMetadata(
        metadata,
        'display.title',
      ),
      retire: () => { current = false; },
      assertCurrent: () => {
        if (!current) throw retirement;
      },
      expectedCode: 'plugin_session_display_title_scope_unavailable',
    });
  });

  it('refreshes the authoritative Session and Account snapshot after every consecutive HTTP 409', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(29),
      },
    };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/initial', host: 'initial-host' },
      agentState: { requests: {} },
      storedContentMode: 'plain',
    });
    const firstAuthoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/first', host: 'first-host' },
      agentState: { requests: { first: { createdAt: 2 } } },
      storedContentMode: 'plain',
    });
    const secondAuthoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/second', host: 'second-host' },
      agentState: { requests: { second: { createdAt: 3 } } },
      storedContentMode: 'plain',
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
        success: false,
        error: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        agentState: { version: 7 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 6 },
        ownerMetadata: { version: 6 },
        agentState: { version: 8 },
      });
    fetchSessionByIdCompatMock
      .mockResolvedValueOnce({
        id: 'sess_layout_consecutive_conflicts',
        metadataLayoutVersion: 1,
        metadata: firstAuthoritative.sharedMetadata.ciphertext,
        metadataVersion: 4,
        ownerMetadata: firstAuthoritative.ownerMetadata,
        agentState: firstAuthoritative.agentState,
        agentStateVersion: 6,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      })
      .mockResolvedValueOnce({
        id: 'sess_layout_consecutive_conflicts',
        metadataLayoutVersion: 1,
        metadata: secondAuthoritative.sharedMetadata.ciphertext,
        metadataVersion: 5,
        ownerMetadata: secondAuthoritative.ownerMetadata,
        agentState: secondAuthoritative.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      });
    const initialCurrentness = e2eeCurrentness(credentials);
    const firstCurrentness = {
      ...initialCurrentness,
      version: 2,
      updatedAt: 2,
    };
    const secondCurrentness = {
      ...initialCurrentness,
      version: 3,
      updatedAt: 3,
    };
    fetchAccountEncryptionCurrentnessMock
      .mockResolvedValueOnce(firstCurrentness)
      .mockResolvedValueOnce(secondCurrentness);

    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_consecutive_conflicts',
      accountEncryptionCurrentness: initialCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: initial.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: initial.ownerMetadata,
        agentState: initial.agentState,
        agentStateVersion: 5,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/requested',
      }),
      maxAttempts: 3,
    });

    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(2);
    expect(fetchAccountEncryptionCurrentnessMock).toHaveBeenCalledTimes(2);
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(3);
    expect(
      patchSessionMetadataEnvelopeTupleMock.mock.calls.map(
        ([request]) => ({
          expectedOwnerMetadata: request.patch.expectedOwnerMetadata,
          sharedMetadataVersion: request.patch.sharedMetadata.expectedVersion,
          agentStateVersion: request.patch.agentState.expectedVersion,
        }),
      ),
    ).toEqual([
      {
        expectedOwnerMetadata: initial.ownerMetadata,
        sharedMetadataVersion: 3,
        agentStateVersion: 5,
      },
      {
        expectedOwnerMetadata: firstAuthoritative.ownerMetadata,
        sharedMetadataVersion: 4,
        agentStateVersion: 6,
      },
      {
        expectedOwnerMetadata: secondAuthoritative.ownerMetadata,
        sharedMetadataVersion: 5,
        agentStateVersion: 7,
      },
    ]);
  });

  it.each(['ECONNABORTED', 'ECONNRESET'] as const)(
    'replays through the shared tuple owner when an ambiguous %s layout-1 write left the exact source unchanged',
    async (code) => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(5),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private', host: 'private-host' },
      agentState: null,
      storedContentMode: 'plain',
    });
    const ambiguous = Object.assign(new Error('request acknowledgement was lost'), {
      code,
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
      ownerMetadata: fields.ownerMetadata,
      agentState: fields.agentState,
      agentStateVersion: 1,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(
      e2eeCurrentness(credentials),
    );

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_ambiguous',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 1,
        ownerMetadata: fields.ownerMetadata,
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
    },
  );
});

import {
  createSessionOwnerMetadataV1,
  ExternalSessionOperationProgressV1Schema,
  projectExternalSessionOperationSharedPresentationV1,
  projectSessionSharedMetadataV1,
  type SessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
  type SessionMetadataTuplePatchV1,
  type SessionSharedMetadataV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  prepareSessionMetadataTuplePatchV1,
  updateSessionMetadataTupleWithRetry,
  type SessionMetadataLegacyOwnerTupleMutationSnapshotV1,
  type SessionMetadataTupleMutationSnapshotV1,
} from './updateSessionMetadataTupleWithRetry.js';

type Metadata = Readonly<Record<string, unknown>>;
type AgentState = Readonly<Record<string, unknown>>;
function ownerSnapshot(params: Readonly<{
  metadata?: Metadata;
  agentState?: AgentState | null;
  metadataVersion?: number;
  sharedMetadataCiphertext?: string;
  ownerMetadataEnvelope?: SessionOwnerMetadataEnvelopeV1;
  agentStateVersion?: number;
  agentStateCiphertext?: string | null;
}> = {}): SessionMetadataTupleMutationSnapshotV1<Metadata, AgentState> {
  const metadata = params.metadata ?? {
    path: '/workspace',
    host: 'local',
    summary: { text: 'before', updatedAt: 1 },
  };
  const created = createSessionOwnerMetadataV1({ metadata });
  if (!created.ok) throw new Error('invalid owner fixture');
  return {
    mode: 'owner',
    metadataLayoutVersion: 1,
    metadataVersion: params.metadataVersion ?? 2,
    sharedMetadataCiphertext:
      params.sharedMetadataCiphertext ?? 'shared-before',
    ownerMetadataEnvelope:
      params.ownerMetadataEnvelope ?? {
        t: 'plain',
        v: created.ownerMetadata,
      },
    agentStateVersion: params.agentStateVersion ?? 4,
    agentStateCiphertext:
      params.agentStateCiphertext ?? null,
    value: {
      metadata,
      sharedMetadata: projectSessionSharedMetadataV1({
        metadata,
        agentState: params.agentState ?? null,
      }),
      ownerMetadata: created.ownerMetadata,
      agentState: params.agentState ?? null,
    },
  };
}

function cryptoAdapter() {
  return {
    encryptPayload: vi.fn(async (payload: unknown) =>
      `encrypted:${JSON.stringify(payload)}`),
    encodeOwnerMetadata: vi.fn(async (owner: SessionOwnerMetadataV1) => ({
      t: 'plain' as const,
      v: owner,
    })),
  };
}

function legacyOwnerSnapshot(params: Readonly<{
  metadata: Metadata;
  agentState?: AgentState | null;
  metadataVersion: number;
  metadataCiphertext: string;
  agentStateVersion: number;
  agentStateCiphertext?: string | null;
}>): SessionMetadataLegacyOwnerTupleMutationSnapshotV1<
  Metadata,
  AgentState
> {
  return {
    mode: 'legacy_owner',
    metadataLayoutVersion: 0,
    metadataVersion: params.metadataVersion,
    metadataCiphertext: params.metadataCiphertext,
    ownerMetadata: null,
    agentStateVersion: params.agentStateVersion,
    agentStateCiphertext: params.agentStateCiphertext ?? null,
    value: {
      metadata: params.metadata,
      agentState: params.agentState ?? null,
    },
  };
}

describe('updateSessionMetadataTupleWithRetry', () => {
  it('atomically seals complete operation progress for the owner and only its shared presentation', async () => {
    const progress = ExternalSessionOperationProgressV1Schema.parse({
      v: 1,
      operationId: 'operation-private-1',
      revision: 4,
      request: {
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
      status: 'running',
      phase: 'staging',
      timeline: ['validating', 'staging', 'importing', 'publishing'],
      updatedAtMs: 1_700_000_000_004,
      priorStableStorage: { state: 'machine_only' },
      currentStorageState: 'machine_only',
      checkpoint: {
        sourcePagesRead: 3,
        stagedItemCount: 2,
        importedItemCount: 0,
        requiredItemFailures: {
          total: 0,
          record: 0,
          media: 0,
          conversion: 0,
          diagnosticsTruncated: false,
        },
      },
      fence: { kind: 'none' },
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          externalSessionOperationV1: { v: 1, progress },
          externalSessionOperationPresentationV1:
            projectExternalSessionOperationSharedPresentationV1(progress),
        }),
      },
      crypto,
      commit,
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerMetadata: expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          runtime: expect.objectContaining({
            externalSessionOperationV1: { v: 1, progress },
          }),
        }),
      }),
      sharedMetadata: expect.objectContaining({
        ciphertext: expect.stringContaining(
          '"externalSessionOperationPresentationV1"',
        ),
      }),
    }));
    const encryptedShared = crypto.encryptPayload.mock.calls[0]?.[0];
    expect(JSON.stringify(encryptedShared)).not.toContain(
      'sourcePagesRead',
    );
    expect(result).toMatchObject({
      mode: 'owner',
      value: {
        metadata: {
          externalSessionOperationV1: { v: 1, progress },
          externalSessionOperationPresentationV1:
            projectExternalSessionOperationSharedPresentationV1(progress),
        },
        ownerMetadata: {
          runtime: {
            externalSessionOperationV1: { v: 1, progress },
          },
        },
        sharedMetadata: {
          externalSessionOperationPresentationV1:
            projectExternalSessionOperationSharedPresentationV1(progress),
        },
      },
    });
  });

  it('preserves the exact owner envelope for a shared-only metadata mutation', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      expectedOwnerMetadata: expect.objectContaining({ t: 'plain' }),
      ownerMetadata: expect.objectContaining({ t: 'plain' }),
    }));
    expect(result).toMatchObject({
      mode: 'owner',
      ownerMetadataEnvelope: { t: 'plain' },
      value: {
        metadata: {
          path: '/workspace',
          host: 'local',
          summary: { text: 'after', updatedAt: 2 },
        },
      },
    });
  });

  it('does not promote synthesized compatibility defaults into unchanged owner metadata', async () => {
    const strictInitial = ownerSnapshot();
    if (strictInitial.mode !== 'owner') throw new Error('expected owner');
    const initial: SessionMetadataTupleMutationSnapshotV1<
      Metadata,
      AgentState
    > = {
      ...strictInitial,
      value: {
        ...strictInitial.value,
        metadata: {
          ...strictInitial.value.metadata,
          version: undefined,
          homeDir: '',
          happyHomeDir: '',
          happyLibDir: '',
          happyToolsDir: '',
        },
      },
    };
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    await updateSessionMetadataTupleWithRetry<Metadata, AgentState>({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerMetadata: expect.objectContaining({ t: 'plain' }),
    }));
  });

  it('splits a private owner mutation and seals only the changed owner projection', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          path: '/workspace/changed',
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      expectedOwnerMetadata: expect.objectContaining({ t: 'plain' }),
      ownerMetadata: expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          workspace: expect.objectContaining({
            path: '/workspace/changed',
          }),
        }),
      }),
    }));
    expect(result).toMatchObject({
      mode: 'owner',
      value: {
        metadata: { path: '/workspace/changed' },
        ownerMetadata: {
          workspace: { path: '/workspace/changed' },
        },
      },
    });
  });

  it('returns the canonical owner compatibility projection instead of raw updater aliases', async () => {
    const crypto = cryptoAdapter();

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'native-1',
            },
          },
        }),
      },
      crypto,
      commit: async () => ({
        result: 'success',
        metadataVersion: 3,
        agentStateVersion: 5,
      }),
    });

    expect(result).toMatchObject({
      mode: 'owner',
      value: {
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
          },
        },
      },
    });
    expect(
      (result.value.metadata as Metadata).agentRuntimeDescriptorV1,
    ).toEqual({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'native-1',
      },
    });
  });

  it('accepts its projected host-session runtime descriptor on a second owner mutation', async () => {
    const first = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {
              backendMode: 'native',
              providerSessionId: 'claude-session-private',
              agentExtra: {
                owner: 'happier',
                schemaId: 'happier.hostSessionRuntimeIdentity',
                v: 1,
                runtimeHandle: {
                  backendId: 'claude',
                  agentId: 'claude',
                  provenance: 'first_party',
                },
              },
            },
          },
        }),
      },
      crypto: cryptoAdapter(),
      commit: async () => ({
        result: 'success',
        metadataVersion: 3,
        agentStateVersion: 5,
      }),
    });
    expect(first.mode).toBe('owner');
    if (first.mode !== 'owner') throw new Error('expected owner tuple');
    expect(first.value.metadata).toMatchObject({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {
          backendMode: 'native',
          providerSessionId: 'claude-session-private',
          backendId: 'claude',
          provenance: 'first_party',
        },
      },
    });
    const secondCommit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 4,
      agentStateVersion: 6,
    }));

    const second = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: first,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'second mutation', updatedAt: 3 },
        }),
      },
      crypto: cryptoAdapter(),
      commit: secondCommit,
    });

    expect(secondCommit).toHaveBeenCalledOnce();
    expect(second).toMatchObject({
      mode: 'owner',
      metadataVersion: 4,
      agentStateVersion: 6,
      value: {
        metadata: {
          summary: { text: 'second mutation', updatedAt: 3 },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {
              backendId: 'claude',
              provenance: 'first_party',
            },
          },
        },
      },
    });
  });

  it('reprojects shared metadata for an Agent-state-only mutation while preserving the owner envelope', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot({
        agentState: {
          requests: {
            r1: {
              tool: 'shell',
              createdAt: 1,
              completedAt: 2,
              status: 'completed',
            },
          },
        },
      }),
      mutation: {
        kind: 'agentState',
        update: (agentState) => ({
          ...agentState,
          controlledByUser: true,
        }),
      },
      crypto,
      commit,
    });

    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(crypto.encryptPayload).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      mode: 'owner',
      ownerMetadataEnvelope: expect.objectContaining({ t: 'plain' }),
      value: {
        agentState: { controlledByUser: true },
      },
    });
  });

  it('reapplies the semantic mutation to the authoritative conflict snapshot', async () => {
    const crypto = cryptoAdapter();
    const authoritative = ownerSnapshot({
      metadata: {
        path: '/concurrent',
        host: 'local',
        name: 'preserve-me',
        summary: { text: 'concurrent', updatedAt: 3 },
      },
      metadataVersion: 3,
      ownerMetadataEnvelope: {
        t: 'encrypted',
        c: 'owner-authoritative',
      },
      agentStateVersion: 5,
    });
    const commit = vi.fn()
      .mockResolvedValueOnce({ result: 'conflict' })
      .mockResolvedValueOnce({
        result: 'success',
        metadataVersion: 4,
        agentStateVersion: 6,
      });
    const refreshAfterConflict = vi.fn(async () => authoritative);

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'requested', updatedAt: 4 },
        }),
      },
      crypto,
      commit,
      refreshAfterConflict,
      maxAttempts: 2,
    });

    expect(commit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedOwnerMetadata: {
        t: 'encrypted',
        c: 'owner-authoritative',
      },
    }));
    expect(result).toMatchObject({
      metadataVersion: 4,
      value: {
        metadata: {
          path: '/concurrent',
          name: 'preserve-me',
          summary: { text: 'requested', updatedAt: 4 },
        },
      },
    });
  });

  it('fails closed on unsupported owner fields before encryption or commit', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn();

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          futurePrivateAuthority: 'must-not-drop',
        }),
      },
      crypto,
      commit,
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      unsupportedFields: ['futurePrivateAuthority'],
      retryable: false,
    });

    expect(crypto.encryptPayload).not.toHaveBeenCalled();
    expect(crypto.encodeOwnerMetadata).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('uses the same strict semantic owner for a shared editor and rejects owner-only fields', async () => {
    const initialShared: SessionSharedMetadataV1 = {
      v: 1,
      summary: { text: 'before', updatedAt: 1 },
    };
    const initial: SessionMetadataTupleMutationSnapshotV1<
      SessionSharedMetadataV1,
      AgentState
    > = {
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      metadataVersion: 7,
      sharedMetadataCiphertext: 'shared-before',
      value: {
        metadata: initialShared,
        sharedMetadata: initialShared,
        ownerMetadata: null,
        agentState: null,
      },
    };
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 8,
    }));

    const result = await updateSessionMetadataTupleWithRetry<
      SessionSharedMetadataV1,
      AgentState
    >({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
    });

    expect(result).toMatchObject({
      mode: 'shared_editor',
      metadataVersion: 8,
      value: {
        metadata: {
          v: 1,
          summary: { text: 'after', updatedAt: 2 },
        },
      },
    });
    expect(commit).toHaveBeenCalledWith({
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      sharedMetadata: {
        ciphertext: expect.stringContaining('"after"'),
        expectedVersion: 7,
      },
    });

    await expect(updateSessionMetadataTupleWithRetry<
      SessionSharedMetadataV1,
      AgentState
    >({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          path: '/owner-only',
        }),
      },
      crypto,
      commit,
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
  });

  it('uses one structural no-op rule independent of object key order', async () => {
    const initial = ownerSnapshot({
      metadata: {
        host: 'local',
        path: '/workspace',
      },
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn();

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: () => ({
          path: '/workspace',
          host: 'local',
        }),
      },
      crypto,
      commit,
    });

    expect(result).toBe(initial);
    expect(crypto.encryptPayload).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('atomically migrates a layout-0 owner while applying its metadata mutation', async () => {
    const initial = legacyOwnerSnapshot({
      metadata: {
        path: '/workspace',
        host: 'local',
        summary: { text: 'Before', updatedAt: 1 },
      },
      agentState: { controlledByUser: false },
      metadataVersion: 2,
      metadataCiphertext: 'metadata-exact-source',
      agentStateVersion: 4,
      agentStateCiphertext: 'agent-exact-source',
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'After', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
      ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'plain',
        expectedAccountContentPublicKeyFingerprint: null,
      },
    });

    expect(commit).toHaveBeenCalledWith({
      mode: 'owner_migration',
      expectedAccountEncryptionMode: 'plain',
      expectedAccountContentPublicKeyFingerprint: null,
      source: {
        metadataLayoutVersion: 0,
        metadata: {
          version: 2,
          ciphertext: 'metadata-exact-source',
        },
        ownerMetadata: null,
        agentState: {
          version: 4,
          ciphertext: 'agent-exact-source',
        },
      },
      target: {
        metadataLayoutVersion: 1,
        sharedMetadata: {
          ciphertext: expect.stringContaining('"After"'),
        },
        ownerMetadata: expect.objectContaining({ t: 'plain' }),
        agentState: {
          ciphertext: expect.stringContaining('"controlledByUser":false'),
        },
      },
    });
    expect(result).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      metadataVersion: 3,
      agentStateVersion: 5,
      value: {
        metadata: {
          summary: { text: 'After', updatedAt: 2 },
        },
        agentState: { controlledByUser: false },
      },
    });
  });

  it('atomically migrates a layout-0 owner while applying its Agent-state mutation', async () => {
    const initial = legacyOwnerSnapshot({
      metadata: {
        path: '/workspace',
        host: 'local',
      },
      agentState: { controlledByUser: false },
      metadataVersion: 2,
      metadataCiphertext: 'metadata-exact-source',
      agentStateVersion: 4,
      agentStateCiphertext: 'agent-exact-source',
    });
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'success' as const,
      metadataVersion: 3,
      agentStateVersion: 5,
    }));

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'agentState',
        update: (agentState) => ({
          ...agentState,
          controlledByUser: true,
        }),
      },
      crypto,
      commit,
      ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'e2ee',
        expectedAccountContentPublicKeyFingerprint:
          `content-public-key-sha256:${'a'.repeat(64)}`,
      },
    });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'owner_migration',
      expectedAccountEncryptionMode: 'e2ee',
      expectedAccountContentPublicKeyFingerprint:
        `content-public-key-sha256:${'a'.repeat(64)}`,
      target: expect.objectContaining({
        agentState: {
          ciphertext: expect.stringContaining('"controlledByUser":true'),
        },
      }),
    }));
    expect(result).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      value: {
        agentState: { controlledByUser: true },
      },
    });
  });

  it('re-resolves owner-migration currentness after a conflict refresh', async () => {
    const initial = legacyOwnerSnapshot({
      metadata: { path: '/workspace', host: 'local' },
      agentState: null,
      metadataVersion: 2,
      metadataCiphertext: 'metadata-source-v2',
      agentStateVersion: 4,
      agentStateCiphertext: null,
    });
    const refreshed = legacyOwnerSnapshot({
      metadata: { path: '/workspace', host: 'local' },
      agentState: null,
      metadataVersion: 3,
      metadataCiphertext: 'metadata-source-v3',
      agentStateVersion: 4,
      agentStateCiphertext: null,
    });
    const resolveOwnerMigrationCurrentness = vi.fn()
      .mockResolvedValueOnce({
        expectedAccountEncryptionMode: 'plain' as const,
        expectedAccountContentPublicKeyFingerprint: null,
      })
      .mockResolvedValueOnce({
        expectedAccountEncryptionMode: 'e2ee' as const,
        expectedAccountContentPublicKeyFingerprint:
          `content-public-key-sha256:${'b'.repeat(64)}`,
      });
    const commit = vi.fn()
      .mockResolvedValueOnce({ result: 'conflict' as const })
      .mockResolvedValueOnce({
        result: 'success' as const,
        metadataVersion: 4,
        agentStateVersion: 5,
      });

    await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({ ...metadata, path: '/workspace/after' }),
      },
      crypto: cryptoAdapter(),
      commit,
      resolveOwnerMigrationCurrentness,
      refreshAfterConflict: async () => refreshed,
      maxAttempts: 2,
    });

    expect(resolveOwnerMigrationCurrentness).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls.map(([request]) => ({
      mode: request.expectedAccountEncryptionMode,
      fingerprint: request.expectedAccountContentPublicKeyFingerprint,
      sourceVersion: request.source.metadata.version,
    }))).toEqual([
      { mode: 'plain', fingerprint: null, sourceVersion: 2 },
      {
        mode: 'e2ee',
        fingerprint: `content-public-key-sha256:${'b'.repeat(64)}`,
        sourceVersion: 3,
      },
    ]);
  });

  it('recognizes the exact migrated target after a lost owner-migration response', async () => {
    const ambiguous = Object.assign(new Error('timeout after write'), {
      code: 'transport_timeout',
    });
    const initial = legacyOwnerSnapshot({
      metadata: { path: '/workspace', host: 'local' },
      agentState: { controlledByUser: false },
      metadataVersion: 2,
      metadataCiphertext: 'metadata-exact-source',
      agentStateVersion: 4,
      agentStateCiphertext: 'agent-exact-source',
    });
    const crypto = cryptoAdapter();
    let migrated: SessionMetadataTupleMutationSnapshotV1<
      Metadata,
      AgentState
    > | null = null;
    const commit = vi.fn(async (patch: SessionMetadataTuplePatchV1) => {
      if (patch.mode !== 'owner_migration') {
        throw new Error('expected owner migration');
      }
      const createdOwner = createSessionOwnerMetadataV1({
        metadata: {
          ...initial.value.metadata,
          summary: { text: 'After', updatedAt: 2 },
        },
      });
      if (!createdOwner.ok) {
        throw new Error('invalid migrated owner fixture');
      }
      migrated = {
        mode: 'owner',
        metadataLayoutVersion: 1,
        metadataVersion: 3,
        sharedMetadataCiphertext: patch.target.sharedMetadata.ciphertext,
        ownerMetadataEnvelope: patch.target.ownerMetadata,
        agentStateVersion: 5,
        agentStateCiphertext: patch.target.agentState.ciphertext,
        value: {
          metadata: {
            ...initial.value.metadata,
            summary: { text: 'After', updatedAt: 2 },
          },
          sharedMetadata: projectSessionSharedMetadataV1({
            metadata: {
              ...initial.value.metadata,
              summary: { text: 'After', updatedAt: 2 },
            },
            agentState: initial.value.agentState,
          }),
          ownerMetadata: createdOwner.ownerMetadata,
          agentState: initial.value.agentState,
        },
      };
      throw ambiguous;
    });

    const result = await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'After', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
      ownerMigrationCurrentness: {
        expectedAccountEncryptionMode: 'plain',
        expectedAccountContentPublicKeyFingerprint: null,
      },
      refreshAfterConflict: async () => migrated ?? initial,
      isAmbiguousCommitError: (error) => error === ambiguous,
    });

    expect(result).toBe(migrated);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('replays after an ambiguous rejection only when the exact source is unchanged', async () => {
    const ambiguous = Object.assign(new Error('timeout after write'), {
      code: 'transport_timeout',
    });
    const initial = ownerSnapshot({
      sharedMetadataCiphertext: 'shared-source',
      ownerMetadataEnvelope: {
        t: 'encrypted',
        c: 'owner-source',
      },
      agentStateCiphertext: null,
    });
    const commit = vi.fn()
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({
        result: 'success' as const,
        metadataVersion: 3,
        agentStateVersion: 5,
      });

    await updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto: cryptoAdapter(),
      commit,
      refreshAfterConflict: async () => initial,
      isAmbiguousCommitError: (error) => error === ambiguous,
      maxAttempts: 2,
    });

    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('fails typed when an ambiguous rejection refreshes a changed non-target tuple', async () => {
    const ambiguous = Object.assign(new Error('timeout after write'), {
      code: 'transport_timeout',
    });
    const initial = ownerSnapshot({
      sharedMetadataCiphertext: 'shared-source',
      ownerMetadataEnvelope: {
        t: 'encrypted',
        c: 'owner-source',
      },
      agentStateCiphertext: null,
    });
    const commit = vi.fn(async () => {
      throw ambiguous;
    });

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: initial,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto: cryptoAdapter(),
      commit,
      refreshAfterConflict: async () => ownerSnapshot({
        metadataVersion: 3,
        sharedMetadataCiphertext: 'shared-different',
        ownerMetadataEnvelope: {
          t: 'encrypted',
          c: 'owner-different',
        },
        agentStateVersion: 5,
        agentStateCiphertext: 'agent-different',
      }),
      isAmbiguousCommitError: (error) => error === ambiguous,
      maxAttempts: 3,
    })).rejects.toMatchObject({
      code: 'metadata_tuple_ambiguous',
      retryable: false,
    });

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('stops after the bounded number of explicit conflict retries', async () => {
    const crypto = cryptoAdapter();
    const commit = vi.fn(async () => ({
      result: 'conflict' as const,
      currentSnapshot: ownerSnapshot({
        metadataVersion: 3,
        ownerMetadataEnvelope: {
          t: 'encrypted',
          c: 'owner-authoritative',
        },
        agentStateVersion: 5,
      }),
    }));

    await expect(updateSessionMetadataTupleWithRetry({
      initialSnapshot: ownerSnapshot(),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'after', updatedAt: 2 },
        }),
      },
      crypto,
      commit,
      maxAttempts: 3,
    })).rejects.toMatchObject({
      code: 'metadata_tuple_conflict',
      retryable: false,
    });

    expect(commit).toHaveBeenCalledTimes(3);
  });
});

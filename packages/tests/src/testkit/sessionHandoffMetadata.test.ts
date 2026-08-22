import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  openSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';

import {
  buildPatchedSessionHandoffMetadata,
  fetchSessionMetadataV2,
  patchSessionHandoffMetadataV1,
  resolveSessionHandoffBackTargetRootPath,
} from './sessionHandoffMetadata';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from './rpcCrypto';
import { encryptLegacyBase64 } from './messageCrypto';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const observation = {
  v: 1,
  qualifiedLinkIdentity: {
    v: 1,
    agent: {
      pluginId: 'acme.external-session-live',
      localId: 'fixture-agent',
    },
    source: {
      kind: 'fixtureLive',
      contractVersion: 1,
    },
  },
  linkGeneration: 'link-generation-1',
  status: 'working',
  observedAtMs: 1_000,
  expiresAtMs: 31_000,
} as const;

function createOwnerMetadata() {
  const created = createSessionOwnerMetadataV1({
    metadata: {
      externalAgentObservationV1: observation,
    },
  });
  if (!created.ok) {
    throw new Error(`Failed to create owner metadata fixture: ${created.unsupportedFields.join(', ')}`);
  }
  return created.ownerMetadata;
}

function createSessionRow(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'session-1',
    seq: 1,
    metadata: 'unused',
    metadataVersion: 2,
    metadataLayoutVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    createdAt: 1,
    updatedAt: 2,
    meaningfulActivityAt: 2,
    active: true,
    activeAt: 2,
    latestTurnStatus: null,
    lastRuntimeIssue: null,
    encryptionMode: 'e2ee',
    dataEncryptionKey: null,
    share: null,
    ...overrides,
  };
}

function installSessionResponses(params: Readonly<{
  listRow: Record<string, unknown>;
  detailRow: Record<string, unknown>;
}>): { requests: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> } {
  const requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      path: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
    });
    if (url.pathname === '/v2/sessions') {
      return new Response(JSON.stringify({
        sessions: [params.listRow],
        nextCursor: null,
        hasNext: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/v2/sessions/session-1') {
      if (method === 'PATCH') {
        return new Response(JSON.stringify({
          success: true,
          metadataLayoutVersion: 1,
          sharedMetadata: { version: params.detailRow.metadataVersion },
          agentState: { version: params.detailRow.agentStateVersion },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ session: params.detailRow }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof globalThis.fetch;
  return { requests };
}

function handoffPatchParams() {
  return {
    baseUrl: 'https://test.invalid',
    token: 'token',
    sessionId: 'session-1',
    providerId: 'claude' as const,
    sourceMachineId: 'machine-source',
    targetMachineId: 'machine-target',
    sourceWorkspaceRootPath: '/Users/source/workspace',
    targetWorkspaceRootPath: '/Users/target/workspace',
    sessionStorageBefore: 'direct' as const,
    sessionStorageAfter: 'direct' as const,
    transportStrategy: 'direct_peer' as const,
    completedAtMs: 1234,
  };
}

describe('fetchSessionMetadataV2', () => {
  it('preserves layout-zero session metadata decryption', async () => {
    const sessionDataKey = Uint8Array.from({ length: 32 }, () => 7);
    const metadata = {
      path: '/Users/fixture/workspace',
      externalAgentObservationV1: observation,
    };
    const row = createSessionRow({
      metadata: encryptDataKeyBase64(metadata, sessionDataKey),
      dataEncryptionKey: Buffer.from(sessionDataKey).toString('base64'),
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      machineKeys: [],
    })).resolves.toEqual(metadata);
  });

  it('opens layout-one E2EE shared and owner envelopes into the canonical owner compatibility view', async () => {
    const accountMachineKey = Uint8Array.from({ length: 32 }, () => 11);
    const sessionDataKey = Uint8Array.from({ length: 32 }, () => 13);
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: { summary: { text: 'Shared summary', updatedAt: 5 } },
    });
    const ownerMetadata = createOwnerMetadata();
    const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      metadata: encryptDataKeyBase64(sharedMetadata, sessionDataKey),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: accountMachineKey },
        ownerMetadata,
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 31),
      }),
      dataEncryptionKey: Buffer.from(encryptedDataKey).toString('base64'),
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      machineKeys: [accountMachineKey],
    })).resolves.toEqual(expect.objectContaining({
      summary: { text: 'Shared summary', updatedAt: 5 },
      externalAgentObservationV1: observation,
    }));
  });

  it('opens layout-one legacy-account owner envelopes through the canonical compatibility view', async () => {
    const accountSecret = Uint8Array.from({ length: 32 }, () => 29);
    const sessionSecret = Uint8Array.from({ length: 32 }, () => 31);
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: { summary: { text: 'Legacy shared summary', updatedAt: 6 } },
    });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      metadata: encryptLegacyBase64(sharedMetadata, sessionSecret),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'legacy', secret: accountSecret },
        ownerMetadata: createOwnerMetadata(),
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 47),
      }),
      dataEncryptionKey: Buffer.from(sessionSecret).toString('base64'),
    });
    installSessionResponses({ listRow: row, detailRow: row });
    const access = {
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      machineKeys: [],
      accountEncryptionMaterials: [{ type: 'legacy', secret: accountSecret }] as const,
    };

    await expect(fetchSessionMetadataV2(access)).resolves.toEqual(expect.objectContaining({
      summary: { text: 'Legacy shared summary', updatedAt: 6 },
      externalAgentObservationV1: observation,
    }));
  });

  it('opens layout-one plain envelopes without Account E2EE material', async () => {
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: { summary: { text: 'Plain shared summary', updatedAt: 8 } },
    });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(sharedMetadata),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(createOwnerMetadata()),
      dataEncryptionKey: null,
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      accountEncryptionMode: 'plain',
    })).resolves.toEqual(expect.objectContaining({
      summary: { text: 'Plain shared summary', updatedAt: 8 },
      externalAgentObservationV1: observation,
    }));
  });

  it('fails closed when the declared Account mode and owner envelope kind differ', async () => {
    const accountMachineKey = Uint8Array.from({ length: 32 }, () => 17);
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(sharedMetadata),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: accountMachineKey },
        ownerMetadata: createOwnerMetadata(),
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 61),
      }),
      dataEncryptionKey: null,
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      accountEncryptionMode: 'plain',
    })).rejects.toThrow(/account_mode_mismatch/);
  });
});

describe('patchSessionHandoffMetadataV1', () => {
  it('keeps layout-zero Sessions on the legacy metadata-only mutation', async () => {
    const sessionDataKey = Uint8Array.from({ length: 32 }, () => 19);
    const metadata = {
      path: '/Users/source/workspace',
      machineId: 'machine-source',
      flavor: 'claude',
      claudeSessionId: 'claude-session-layout-zero',
    };
    const row = createSessionRow({
      metadataVersion: 5,
      metadata: encryptDataKeyBase64(metadata, sessionDataKey),
      agentState: 'intentionally-unread-by-metadata-only-handoff',
      dataEncryptionKey: Buffer.from(sessionDataKey).toString('base64'),
    });
    const { requests } = installSessionResponses({ listRow: row, detailRow: row });

    await patchSessionHandoffMetadataV1({
      ...handoffPatchParams(),
      machineKeys: [],
    });

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      metadata: { expectedVersion: 5 },
    });
    expect(patch?.body).not.toHaveProperty('mode');
  });

  it('patches a layout-one E2EE Session through the canonical tuple while preserving private owner separation and exact CAS versions', async () => {
    const accountMachineKey = Uint8Array.from({ length: 32 }, () => 21);
    const sessionDataKey = Uint8Array.from({ length: 32 }, () => 23);
    const metadata = {
      summary: { text: 'Shared summary', updatedAt: 5 },
      path: '/Users/source/workspace',
      machineId: 'machine-source',
      flavor: 'claude',
      claudeSessionId: 'claude-session-1',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-source',
        remoteSessionId: 'claude-session-1',
        source: { kind: 'claudeConfig', configDir: '/Users/source/.claude' },
        linkedAtMs: 1,
      },
    };
    const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
    if (!ownerMetadata.ok) {
      throw new Error(`Failed to create owner metadata fixture: ${ownerMetadata.unsupportedFields.join(', ')}`);
    }
    const previousOwnerEnvelope = sealSessionOwnerMetadataEnvelopeV1({
      material: { type: 'dataKey', machineKey: accountMachineKey },
      ownerMetadata: ownerMetadata.ownerMetadata,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 31),
    });
    const agentState = {
      completedRequests: {
        private: {
          tool: 'Bash',
          createdAt: 2,
          completedAt: 3,
          status: 'approved',
        },
      },
    };
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      metadataVersion: 7,
      agentStateVersion: 9,
      metadata: encryptDataKeyBase64(projectSessionSharedMetadataV1({ metadata, agentState }), sessionDataKey),
      ownerMetadata: previousOwnerEnvelope,
      agentState: encryptDataKeyBase64(agentState, sessionDataKey),
      dataEncryptionKey: Buffer.from(encryptedDataKey).toString('base64'),
    });
    const { requests } = installSessionResponses({ listRow: row, detailRow: row });

    await patchSessionHandoffMetadataV1({
      ...handoffPatchParams(),
      machineKeys: [accountMachineKey],
    });

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      expectedOwnerMetadata: previousOwnerEnvelope,
      sharedMetadata: { expectedVersion: 7 },
      agentState: { expectedVersion: 9 },
    });
    expect(patch?.body).not.toHaveProperty('metadata');
    expect(patch?.headers['x-happier-account-stored-content-protocol']).toBe('2');

    const body = patch?.body as {
      sharedMetadata: { ciphertext: string };
      ownerMetadata: unknown;
      agentState: { ciphertext: string };
    };
    expect(decryptDataKeyBase64(body.sharedMetadata.ciphertext, sessionDataKey)).toMatchObject({
      v: 1,
      summary: metadata.summary,
      publicAgentState: {
        completedRequests: {
          private: {
            tool: 'Bash',
            createdAt: 2,
            completedAt: 3,
            status: 'approved',
          },
        },
      },
    });
    expect(decryptDataKeyBase64(body.sharedMetadata.ciphertext, sessionDataKey)).not.toHaveProperty('path');
    expect(decryptDataKeyBase64(body.agentState.ciphertext, sessionDataKey)).toEqual(agentState);
    expect(openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      envelope: body.ownerMetadata,
      material: { type: 'dataKey', machineKey: accountMachineKey },
    })).toMatchObject({
      ok: true,
      ownerMetadata: {
        workspace: {
          path: '/Users/target/workspace',
          machineId: 'machine-target',
        },
      },
    });
  });

  it('patches a layout-one plain Session without Account E2EE material and never emits the legacy metadata-only body', async () => {
    const metadata = {
      summary: { text: 'Plain shared summary', updatedAt: 8 },
      path: '/Users/source/workspace',
      machineId: 'machine-source',
      flavor: 'claude',
      claudeSessionId: 'claude-session-plain',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-source',
        remoteSessionId: 'claude-session-plain',
        source: { kind: 'claudeConfig', configDir: '/Users/source/.claude' },
        linkedAtMs: 1,
      },
    };
    const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
    if (!ownerMetadata.ok) {
      throw new Error(`Failed to create owner metadata fixture: ${ownerMetadata.unsupportedFields.join(', ')}`);
    }
    const agentState = { privateState: 'retained' };
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadataVersion: 11,
      agentStateVersion: 13,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState })),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata),
      agentState: JSON.stringify(agentState),
      dataEncryptionKey: null,
    });
    const { requests } = installSessionResponses({ listRow: row, detailRow: row });

    await patchSessionHandoffMetadataV1({
      ...handoffPatchParams(),
      accountEncryptionMode: 'plain',
    });

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      sharedMetadata: { expectedVersion: 11 },
      ownerMetadata: { t: 'plain' },
      agentState: { expectedVersion: 13 },
    });
    expect(patch?.body).not.toHaveProperty('metadata');
    const body = patch?.body as {
      sharedMetadata: { ciphertext: string };
      ownerMetadata: { t: 'plain'; v: Record<string, unknown> };
      agentState: { ciphertext: string };
    };
    expect(JSON.parse(body.sharedMetadata.ciphertext)).toMatchObject({
      v: 1,
      summary: metadata.summary,
    });
    expect(JSON.parse(body.sharedMetadata.ciphertext)).not.toHaveProperty('path');
    expect(body.ownerMetadata.v).toMatchObject({
      workspace: {
        path: '/Users/target/workspace',
        machineId: 'machine-target',
      },
    });
    expect(JSON.parse(body.agentState.ciphertext)).toEqual(agentState);
  });

  it('fails closed before PATCH when the declared Account mode disagrees with the layout-one owner envelope', async () => {
    const accountMachineKey = Uint8Array.from({ length: 32 }, () => 25);
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: accountMachineKey },
        ownerMetadata: createOwnerMetadata(),
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 61),
      }),
      dataEncryptionKey: null,
    });
    const { requests } = installSessionResponses({ listRow: row, detailRow: row });

    await expect(patchSessionHandoffMetadataV1({
      ...handoffPatchParams(),
      accountEncryptionMode: 'plain',
    })).rejects.toThrow(/account_mode_mismatch/);
    expect(requests).not.toContainEqual(expect.objectContaining({ method: 'PATCH' }));
  });
});

describe('buildPatchedSessionHandoffMetadata', () => {
  it('refreshes the Claude handoff metadata contract for a direct session rebinding', () => {
    const updated = buildPatchedSessionHandoffMetadata(
      {
        flavor: 'claude',
        path: '/Users/source/workspace',
        host: 'source-host',
        machineId: 'machine_source',
        claudeSessionId: 'claude_old',
        claudeTranscriptPath: '/Users/source/.claude/projects/proj-old/claude_old.jsonl',
        claudeLastCheckpointId: 'checkpoint_old',
        claudeLastAssistantUuid: 'assistant_old',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine_source',
          remoteSessionId: 'claude_old',
          source: {
            kind: 'claudeConfig',
            configDir: '/Users/source/.claude',
            projectId: 'proj-old',
          },
          linkedAtMs: 1,
        },
        externalHistoryImportV1: {
          v: 1,
          providerId: 'claude',
          remoteSessionId: 'old_remote',
          importedAtMs: 1,
          source: {
            kind: 'claudeConfig',
            configDir: '/Users/source/.claude',
            projectId: 'proj-old',
          },
        },
      },
      {
        providerId: 'claude',
        targetMachineId: 'machine_target',
        targetWorkspaceRootPath: '/Users/target/workspace',
        sessionStorageAfter: 'direct',
        completedAtMs: 1234,
      },
    );

    expect(updated).toEqual(expect.objectContaining({
      flavor: 'claude',
      machineId: 'machine_target',
      path: '/Users/target/workspace',
      claudeSessionId: 'claude_old',
      directSessionV1: expect.objectContaining({
        providerId: 'claude',
        machineId: 'machine_target',
        remoteSessionId: 'claude_old',
        linkedAtMs: 1234,
      }),
    }));
    expect(updated.claudeTranscriptPath).toBeUndefined();
    expect(updated.claudeLastCheckpointId).toBeUndefined();
    expect(updated.claudeLastAssistantUuid).toBeUndefined();
    expect(updated.externalHistoryImportV1).toBeUndefined();
  });

  it('preserves the server-routed handoff-back root path through a direct-session rebinding round trip', () => {
    const patched = buildPatchedSessionHandoffMetadata(
      {
        flavor: 'claude',
        path: '/Users/source/workspace',
        machineId: 'machine_source',
        claudeSessionId: 'claude_old',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine_source',
          remoteSessionId: 'claude_old',
          source: {
            kind: 'claudeConfig',
            configDir: '/Users/source/.claude',
            projectId: 'proj-old',
          },
          linkedAtMs: 1,
        },
        handoffV1: {
          v: 1,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          providerId: 'claude',
          sessionStorageBefore: 'direct',
          sessionStorageAfter: 'direct',
          transportStrategy: 'server_routed_stream',
          completedAtMs: 1,
          sourceWorkspaceRootPath: '/Users/source/workspace',
          targetWorkspaceRootPath: '/Users/source/workspace',
        },
        workspaceReplicationSourceRootPath: '/Users/source/workspace',
        workspaceReplicationHandoffBackTargetRootPath: '/Users/source/workspace',
      },
      {
        providerId: 'claude',
        targetMachineId: 'machine_target',
        targetWorkspaceRootPath: '/Users/target/workspace',
        sessionStorageAfter: 'direct',
        completedAtMs: 1234,
      },
    );

    expect(patched.workspaceReplicationHandoffBackTargetRootPath).toBe('/Users/source/workspace');
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: patched,
      requestedTargetMachineId: 'machine_source',
    })).toBe('/Users/source/workspace');
  });

  it('canonicalizes nested legacy direct-session runtime descriptors onto runtimeDescriptorV1', () => {
    const patched = buildPatchedSessionHandoffMetadata(
      {
        flavor: 'codex',
        path: '/Users/source/workspace',
        machineId: 'machine_source',
        codexSessionId: 'thread_old',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine_source',
          remoteSessionId: 'thread_old',
          source: {
            kind: 'codexHome',
            home: 'user',
          },
          linkedAtMs: 1,
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'thread_old',
            },
          },
        },
      },
      {
        providerId: 'codex',
        targetMachineId: 'machine_target',
        targetWorkspaceRootPath: '/Users/target/workspace',
        sessionStorageAfter: 'direct',
        completedAtMs: 1234,
      },
    );

    expect(patched.directSessionV1).toEqual(expect.objectContaining({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread_old',
        },
      },
    }));
    expect(patched.directSessionV1).not.toHaveProperty('agentRuntimeDescriptorV1');
  });
});

describe('resolveSessionHandoffBackTargetRootPath', () => {
  it('prefers a valid Windows workspace replication handoff-back root path', () => {
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        workspaceReplicationHandoffBackTargetRootPath: 'C:\\Users\\source\\workspace',
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/legacy',
        },
      },
      requestedTargetMachineId: 'machine_source',
    })).toBe('C:\\Users\\source\\workspace');
  });

  it('falls back to the prior source workspace root when the requested target machine matches the prior source machine', () => {
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/workspace',
        },
      },
      requestedTargetMachineId: 'machine_source',
    })).toBe('/Users/source/workspace');
  });

  it('fails closed when the explicit or fallback workspace roots are invalid or target the wrong machine', () => {
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        workspaceReplicationHandoffBackTargetRootPath: '../relative-path',
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/workspace',
        },
      },
      requestedTargetMachineId: 'machine_other',
    })).toBeNull();

    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        workspaceReplicationHandoffBackTargetRootPath: '/Users/source/../workspace',
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/../workspace',
        },
      },
      requestedTargetMachineId: 'machine_source',
    })).toBeNull();
  });
});

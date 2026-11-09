import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ExternalSessionOperationRecordV1Schema,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredCredentials } from '@/persistence';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { deriveExternalSessionPluginOperationDurableKey } from '@/session/external/pluginOperationDurableKey';

const mocks = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  callMachineRpc: vi.fn(),
}));

// Only HTTP/RPC and persisted-credential boundaries are replaced; metadata and durable
// admission decisions run through their production owners.
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: mocks.fetchSessionById,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: mocks.fetchAccountEncryptionCurrentness,
}));
vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc: mocks.callMachineRpc,
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => credentials,
}));

import { executePluginExternalSessionAction } from './pluginExternalSessionActionExecutor';
import {
  acknowledgeExternalSessionOperationProgressProjection,
  compactExternalSessionOperationRecordToTerminalReceipt,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';

// This boundary fixture carries a stable Account subject while still exposing
// the opaque token as an external transport value.
const credentials = {
  token: `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'vitest' })).toString('base64url')}.`,
  encryption: null,
} satisfies StoredCredentials;
const roots: string[] = [];

function sessionRecord(metadata: Record<string, unknown> = {
  externalSessionV1: {
    v: 1,
    machineId: 'machine-private',
    agentId: 'codex',
    remoteSessionId: 'remote-private',
    source: { kind: 'codexHome', home: '/private/home' },
    linkedAtMs: 1,
  },
}) {
  const fields = buildSessionMetadataEnvelopeFields({
    credentials,
    accountEncryptionMode: 'plain',
    storedContentMode: 'plain',
    metadata,
    agentState: null,
  });
  return {
    id: 'session-1',
    encryptionMode: 'plain',
    metadataLayoutVersion: fields.metadataLayoutVersion,
    metadata: fields.sharedMetadata.ciphertext,
    ownerMetadata: fields.ownerMetadata,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchSessionById.mockResolvedValue(sessionRecord());
  mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain' });
});

function materializeInput(idempotencyKey: string) {
  return {
    request: {
      v: 1 as const,
      idempotencyKey,
      sessionId: 'session-1',
      plan: 'materialize' as const,
      targetStorageMode: 'external-linked' as const,
      targetRuntimeMode: null,
    },
  };
}

function terminalOperationRecord(input: Readonly<{
  operationId?: string;
  sessionId?: string;
  terminalAtMs?: number;
  status?: 'completed' | 'cancelled' | 'discarded';
}>) {
  const request: ExternalSessionOperationRecordV1['request'] = {
    v: 1 as const,
    idempotencyKey: 'plugin-operation:v1:takeover:test-key',
    sessionId: input.sessionId ?? 'session-1',
    source: {
      machineId: 'machine-private',
      remoteSessionId: 'remote-private',
      qualifiedIdentity: {
        v: 1 as const,
        agent: { pluginId: 'example.plugin', localId: 'example' },
        source: { kind: 'jsonl', contractVersion: 1 as const },
      },
      linkGeneration: 'link-1',
      sourceGeneration: 'source-1',
      sourceCustody: { kind: 'development', registeredRootId: 'contribution-1' },
    },
    plan: 'takeover' as const,
    targetStorageMode: 'external-linked' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  const terminalAtMs = input.terminalAtMs ?? 25_000;
  const status = input.status ?? 'completed';
  return ExternalSessionOperationRecordV1Schema.parse({
    v: 1,
    operationId: input.operationId ?? 'operation-1',
    revision: 6,
    request,
    status,
    phase: 'finalizing',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: terminalAtMs,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'machine_only',
    checkpoint: {
      sourcePagesRead: 0,
      stagedItemCount: 0,
      importedItemCount: 0,
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
    },
    bindings: { operationClaimId: 'private-claim' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 1 },
    fence: { kind: 'none' },
    ...(status === 'cancelled'
      ? {
          cancellation: {
            requestedAtMs: 2,
            requestedAtRevision: 6,
          },
        }
      : {}),
    terminalResult: { kind: status },
  });
}

async function createOperationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugin-operation-status-'));
  roots.push(root);
  return root;
}

async function seedTerminalReceipt(input: Readonly<{
  activeServerDir: string;
  operationId?: string;
  sessionId?: string;
  terminalAtMs?: number;
  status?: 'completed' | 'cancelled' | 'discarded';
}>) {
  const record = terminalOperationRecord(input);
  await writeExternalSessionOperationRecord(input.activeServerDir, record);
  await acknowledgeExternalSessionOperationProgressProjection({
    activeServerDir: input.activeServerDir,
    operationId: record.operationId,
    projectedRevision: record.revision,
  });
  const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
    activeServerDir: input.activeServerDir,
    operationId: record.operationId,
    expectedRevision: record.revision,
    stagingDisposition: 'not_applicable',
  });
  if (compacted.status === 'not_eligible') {
    throw new Error(`Expected terminal receipt, got ${compacted.reason}`);
  }
  return compacted.receipt;
}

async function seedMaterializeRecord(activeServerDir: string, callerKey: string, sessionId = 'session-1') {
  const base = terminalOperationRecord({ sessionId });
  const request = {
    v: 1 as const,
    sessionId,
    source: base.request.source,
    idempotencyKey: deriveExternalSessionPluginOperationDurableKey({
      pluginId: 'author.example', callerKey,
    }),
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
  };
  const record = ExternalSessionOperationRecordV1Schema.parse({
    ...base,
    request,
    timeline: resolveExternalSessionOperationTimelineV1(request),
    phase: 'publishing',
    currentStorageState: 'snapshot_complete',
    publication: {
      materializationPublicationId: 'publication-1',
      materializedThroughSourceAt: 25_000,
      publishedThroughServerSeq: 0,
    },
    authorIntent: {
      v: 1,
      surface: 'plugin',
      kind: 'materialize',
      sessionId,
      targetStorageMode: 'external-linked',
    },
  });
  await writeExternalSessionOperationRecord(activeServerDir, record);
  return record;
}

function storedOperationPath(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(
    activeServerDir,
    'external-session-operations',
    'by-account',
    `sub-${createHash('sha256').update('vitest', 'utf8').digest('hex').slice(0, 32)}`,
    'records',
    `${key}.json`,
  );
}

describe('plugin External Session action executor', () => {
  it('resolves private linked authority and invokes the existing RPC owner', async () => {
    mocks.callMachineRpc.mockResolvedValue({ ok: true, machineOnline: true });
    const signal = new AbortController().signal;

    await executePluginExternalSessionAction({
      actionId: 'sessions.external.status.get',
      input: { sessionId: 'session-1' },
      credentials,
      pluginId: 'author.example',
      signal,
    });

    expect(mocks.fetchSessionById).toHaveBeenCalledWith({
      reason: 'session-control',
      token: credentials.token,
      sessionId: 'session-1',
      signal,
    });
    expect(mocks.callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-private',
      method: 'daemon.externalSessions.status.get',
      request: {
        sessionId: 'session-1',
        machineId: 'machine-private',
        agentId: 'codex',
        remoteSessionId: 'remote-private',
        source: { kind: 'codexHome', home: '/private/home' },
      },
      signal,
    });
  });

  it('passes operation references without manufacturing private claims', async () => {
    const activeServerDir = await createOperationRoot();
    await writeExternalSessionOperationRecord(
      activeServerDir,
      terminalOperationRecord({}),
    );
    mocks.callMachineRpc.mockResolvedValue({
      ok: false,
      error: { code: 'operation_not_found', message: 'gone' },
    });
    const input = { sessionId: 'session-1', operationId: 'operation-1', revision: 2 };

    await executePluginExternalSessionAction({
      actionId: 'sessions.external.operation.status.get',
      input,
      credentials,
      pluginId: 'author.example',
    }, { activeServerDir });

    expect(mocks.callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-private',
      method: 'daemon.externalSessions.operation.status.get',
      request: input,
    });
  });

  it.each(['completed', 'cancelled', 'discarded'] as const)(
    'returns a retained %s terminal receipt through recipient-safe status without machine RPC',
    async (status) => {
      const activeServerDir = await createOperationRoot();
      const receipt = await seedTerminalReceipt({ activeServerDir, status });

      const result = await executePluginExternalSessionAction({
        actionId: 'sessions.external.operation.status.get',
        input: receipt.reference,
        credentials,
        pluginId: 'author.example',
      }, { activeServerDir });

      expect(result).toEqual({
        ok: true,
        result: {
          ok: true,
          operation: receipt.reference,
          presentation: receipt.presentation,
        },
      });
      expect(Object.keys(receipt.presentation).sort()).toEqual([
        'kind',
        'operationId',
        'phase',
        'revision',
        'status',
        'v',
      ]);
      expect(receipt.presentation.status).toBe(status);
      expect(mocks.fetchSessionById).toHaveBeenCalledWith({
        reason: 'session-control',
        token: credentials.token,
        sessionId: receipt.reference.sessionId,
      });
      expect(mocks.callMachineRpc).not.toHaveBeenCalled();
    },
  );

  it('preserves linked-Session authorization before reading a local receipt', async () => {
    const activeServerDir = await createOperationRoot();
    const operationId = 'operation-1';
    const path = storedOperationPath(activeServerDir, operationId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{', 'utf8');
    mocks.fetchSessionById.mockResolvedValueOnce(null);

    const result = await executePluginExternalSessionAction({
      actionId: 'sessions.external.operation.status.get',
      input: { sessionId: 'session-1', operationId, revision: 6 },
      credentials,
      pluginId: 'author.example',
    }, { activeServerDir });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'session_not_found',
    });
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'cross-session',
      input: { sessionId: 'session-other', operationId: 'operation-1', revision: 6 },
      expectedCode: 'operation_not_found',
    },
    {
      name: 'stale revision',
      input: { sessionId: 'session-1', operationId: 'operation-1', revision: 5 },
      expectedCode: 'stale_revision',
    },
    {
      name: 'cross-operation',
      input: { sessionId: 'session-1', operationId: 'operation-other', revision: 6 },
      expectedCode: 'operation_not_found',
    },
  ])('does not disclose or alias a retained receipt for $name input', async ({
    input,
    expectedCode,
  }) => {
    const activeServerDir = await createOperationRoot();
    const receipt = await seedTerminalReceipt({ activeServerDir });

    const result = await executePluginExternalSessionAction({
      actionId: 'sessions.external.operation.status.get',
      input,
      credentials,
      pluginId: 'author.example',
    }, { activeServerDir });

    expect(result).toMatchObject({
      ok: true,
      result: { ok: false, error: { code: expectedCode } },
    });
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it('retains old terminal outcomes while a missing reference stays unavailable without machine RPC', async () => {
    const activeServerDir = await createOperationRoot();
    const receipt = await seedTerminalReceipt({ activeServerDir });

    await expect(executePluginExternalSessionAction({
      actionId: 'sessions.external.operation.status.get',
      input: receipt.reference,
      credentials,
      pluginId: 'author.example',
    }, { activeServerDir })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, operation: receipt.reference, presentation: receipt.presentation },
    });
    await expect(executePluginExternalSessionAction({
        actionId: 'sessions.external.operation.status.get',
        input: { ...receipt.reference, operationId: 'operation-missing' },
        credentials,
        pluginId: 'author.example',
      }, { activeServerDir })).resolves.toMatchObject({
        ok: true,
        result: { ok: false, error: { code: 'operation_not_found' } },
      });
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', '{'],
    ['future', JSON.stringify({ v: 2, recordKind: 'terminal_receipt' })],
  ])('fails closed for a %s stored operation entry', async (_kind, contents) => {
    const activeServerDir = await createOperationRoot();
    const operationId = 'operation-1';
    const path = storedOperationPath(activeServerDir, operationId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');

    const result = await executePluginExternalSessionAction({
      actionId: 'sessions.external.operation.status.get',
      input: { sessionId: 'session-1', operationId, revision: 6 },
      credentials,
      pluginId: 'author.example',
    }, { activeServerDir });

    expect(result).toMatchObject({
      ok: true,
      result: { ok: false, error: { code: 'internal_error' } },
    });
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it.each([
    ' padded-key',
    'padded-key ',
    'x'.repeat(257),
  ])('rejects a non-canonical materialize key before durable admission: %j', async (idempotencyKey) => {
    const materializeStart = vi.fn();
    const activeServerDir = await createOperationRoot();

    const result = await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput(idempotencyKey),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(mocks.fetchSessionById).not.toHaveBeenCalled();
    expect(materializeStart).not.toHaveBeenCalled();
  });

  it('authorizes the current Session owner before consulting the durable author-intent owner', async () => {
    const activeServerDir = await createOperationRoot();
    await seedMaterializeRecord(activeServerDir, 'authorized-before-preflight');
    mocks.fetchSessionById.mockResolvedValueOnce({
      ...sessionRecord(),
      ownerMetadata: null,
    });
    const materializeStart = vi.fn();

    await expect(executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('authorized-before-preflight'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir })).resolves.toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'session_metadata_unavailable',
    });

    expect(materializeStart).not.toHaveBeenCalled();
  });

  it('replays the durable operation before parsing the mutable current link', async () => {
    const activeServerDir = await createOperationRoot();
    const record = await seedMaterializeRecord(activeServerDir, 'replay-before-link-parse');
    // Valid owner metadata remains readable, but it no longer has an external link.
    mocks.fetchSessionById.mockResolvedValue(sessionRecord({}));
    const materializeStart = vi.fn();

    await expect(executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('replay-before-link-parse'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        operation: {
          sessionId: record.request.sessionId,
          operationId: record.operationId,
          revision: record.revision,
        },
      },
    });
    expect(materializeStart).not.toHaveBeenCalled();
  });

  it('separates opaque keys and host-stamped plugin identities before direct Start', async () => {
    const activeServerDir = await createOperationRoot();
    const materializeStart = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'operation_unavailable', message: 'not started' },
    });

    for (const [key, pluginId] of [
      ['\uD800', 'author.one'],
      ['\uD801', 'author.one'],
      ['\uD800', 'author.two'],
    ] as const) {
      await executePluginExternalSessionAction({
        actionId: 'sessions.external.materialize.start',
        input: materializeInput(key),
        credentials,
        pluginId,
      }, { materializeStart, activeServerDir });
    }

    expect(materializeStart).toHaveBeenCalledTimes(3);
    const keys = materializeStart.mock.calls.map(([input]) => input.durableIdempotencyKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^plugin-operation:v1:[0-9a-f]{64}$/);
    for (let index = 0; index < 3; index++) {
      expect(materializeStart).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
        sessionId: 'session-1',
        durableIdempotencyKey: keys[index],
        authorIntent: {
          v: 1,
          surface: 'plugin',
          kind: 'materialize',
          sessionId: 'session-1',
          targetStorageMode: 'external-linked',
        },
      }));
    }
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it('returns a changed-intent conflict only after current linked-Session authorization', async () => {
    const activeServerDir = await createOperationRoot();
    await seedMaterializeRecord(activeServerDir, 'changed-intent', 'session-other');
    mocks.fetchSessionById.mockResolvedValue(sessionRecord({}));
    const materializeStart = vi.fn();
    const args = {
      actionId: 'sessions.external.materialize.start' as const,
      input: materializeInput('changed-intent'),
      credentials,
      pluginId: 'author.example',
    };

    mocks.fetchSessionById.mockResolvedValueOnce({ ...sessionRecord(), ownerMetadata: null });
    await expect(executePluginExternalSessionAction(args, {
      materializeStart, activeServerDir,
    })).resolves.toMatchObject({ ok: false, errorCode: 'agent_unavailable' });

    await expect(executePluginExternalSessionAction(args, {
      materializeStart, activeServerDir,
    })).resolves.toMatchObject({
      ok: true,
      result: { ok: false, error: { code: 'operation_conflict' } },
    });
    expect(materializeStart).not.toHaveBeenCalled();
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it('converges repeated same-plugin intent to the retained public operation reference', async () => {
    const activeServerDir = await createOperationRoot();
    const record = await seedMaterializeRecord(activeServerDir, 'same-key');
    await acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir, operationId: record.operationId, projectedRevision: record.revision,
    });
    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: record.operationId,
      expectedRevision: record.revision,
      stagingDisposition: 'missing',
    });
    if (compacted.status === 'not_eligible') throw new Error(compacted.reason);
    const receipt = compacted.receipt;
    mocks.fetchSessionById.mockResolvedValue(sessionRecord({}));
    const materializeStart = vi.fn();

    const run = () => executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('same-key'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir });
    const first = await run();
    const second = await run();

    expect(first).toEqual({
      ok: true,
      result: { ok: true, operation: receipt.reference },
    });
    expect(first).not.toHaveProperty('result.presentation');
    expect(second).toEqual(first);
    expect(materializeStart).not.toHaveBeenCalled();
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it('refuses a true miss whose current link no longer resolves before Start', async () => {
    const activeServerDir = await createOperationRoot();
    // A malformed linked-metadata payload remains owner-readable in the
    // supported legacy layout, so this reaches the link parser, not decryption.
    mocks.fetchSessionById.mockResolvedValue({
      id: 'session-1',
      encryptionMode: 'plain',
      metadataLayoutVersion: 0,
      metadata: JSON.stringify({ externalSessionV1: { v: 1 } }),
    });
    const materializeStart = vi.fn();

    await expect(executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('miss-requires-valid-link'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_metadata_invalid',
    });
    expect(materializeStart).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ExternalSessionOperationRecordV1Schema,
  resolveExternalSessionOperationTimelineV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredCredentials } from '@/persistence';

const mocks = vi.hoisted(() => ({
  loadPersistedLinkedExternalSession: vi.fn(),
  callMachineRpc: vi.fn(),
  resolveExternalSessionPluginOperationPreflightAdmission: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
  loadPersistedLinkedExternalSession: mocks.loadPersistedLinkedExternalSession,
}));
vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc: mocks.callMachineRpc,
}));
vi.mock('./operationRecordStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('./operationRecordStore')>(),
  resolveExternalSessionPluginOperationPreflightAdmission:
    mocks.resolveExternalSessionPluginOperationPreflightAdmission,
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
  token: `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'plugin-test-account' })).toString('base64url')}.`,
} as unknown as StoredCredentials;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPersistedLinkedExternalSession.mockResolvedValue({
    ok: true,
    session: {
      machineId: 'machine-private',
      agentId: 'codex',
      remoteSessionId: 'remote-private',
      source: { kind: 'codexHome', home: '/private/home' },
    },
  });
  mocks.resolveExternalSessionPluginOperationPreflightAdmission.mockResolvedValue({
    kind: 'miss',
  });
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
  const request = {
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
      contributionGeneration: 'contribution-1',
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

    expect(mocks.loadPersistedLinkedExternalSession).toHaveBeenCalledWith({
      credentials,
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
    }, { activeServerDir, nowMs: () => 25_000 });

    expect(mocks.callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-private',
      method: 'daemon.externalSessions.operation.status.get',
      request: input,
    });
  });

  it.each(['completed', 'cancelled', 'discarded'] as const)(
    'returns an unexpired %s terminal receipt through recipient-safe status without machine RPC',
    async (status) => {
      const activeServerDir = await createOperationRoot();
      const receipt = await seedTerminalReceipt({ activeServerDir, status });

      const result = await executePluginExternalSessionAction({
        actionId: 'sessions.external.operation.status.get',
        input: receipt.reference,
        credentials,
        pluginId: 'author.example',
      }, { activeServerDir, nowMs: () => receipt.expiresAtMs - 1 });

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
      expect(mocks.loadPersistedLinkedExternalSession).toHaveBeenCalledWith({
        credentials,
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
    mocks.loadPersistedLinkedExternalSession.mockResolvedValueOnce({
      ok: false,
      errorCode: 'invalid_request',
      error: 'Session is unavailable.',
    });

    const result = await executePluginExternalSessionAction({
      actionId: 'sessions.external.operation.status.get',
      input: { sessionId: 'session-1', operationId, revision: 6 },
      credentials,
      pluginId: 'author.example',
    }, { activeServerDir, nowMs: () => 25_000 });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'Session is unavailable.',
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
  ])('does not disclose or alias an unexpired receipt for $name input', async ({
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
    }, { activeServerDir, nowMs: () => receipt.expiresAtMs - 1 });

    expect(result).toMatchObject({
      ok: true,
      result: { ok: false, error: { code: expectedCode } },
    });
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it('treats expired and missing receipt references as unavailable without machine RPC', async () => {
    const activeServerDir = await createOperationRoot();
    const receipt = await seedTerminalReceipt({ activeServerDir });

    for (const [input, nowMs] of [
      [receipt.reference, receipt.expiresAtMs],
      [{ ...receipt.reference, operationId: 'operation-missing' }, receipt.expiresAtMs - 1],
    ] as const) {
      await expect(executePluginExternalSessionAction({
        actionId: 'sessions.external.operation.status.get',
        input,
        credentials,
        pluginId: 'author.example',
      }, { activeServerDir, nowMs: () => nowMs })).resolves.toMatchObject({
        ok: true,
        result: { ok: false, error: { code: 'operation_not_found' } },
      });
    }
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
    }, { activeServerDir, nowMs: () => 25_000 });

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

    const result = await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput(idempotencyKey),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir: '/unused' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(mocks.resolveExternalSessionPluginOperationPreflightAdmission).not.toHaveBeenCalled();
    expect(mocks.loadPersistedLinkedExternalSession).not.toHaveBeenCalled();
    expect(materializeStart).not.toHaveBeenCalled();
  });

  it('authorizes the current linked Session before inspecting a durable materialize receipt or conflict', async () => {
    mocks.loadPersistedLinkedExternalSession.mockResolvedValueOnce({
      ok: false,
      errorCode: 'invalid_request',
      error: 'Session is unavailable.',
    });
    const materializeStart = vi.fn();

    await expect(executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('authorized-before-preflight'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir: '/unused' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'Session is unavailable.',
    });

    expect(mocks.loadPersistedLinkedExternalSession).toHaveBeenCalledWith({
      credentials,
      sessionId: 'session-1',
    });
    expect(mocks.resolveExternalSessionPluginOperationPreflightAdmission)
      .not.toHaveBeenCalled();
    expect(materializeStart).not.toHaveBeenCalled();
  });

  it('separates opaque keys and host-stamped plugin identities before direct Start', async () => {
    const materializeStart = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'operation_unavailable', message: 'not started' },
    });

    await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('\uD800'),
      credentials,
      pluginId: 'author.one',
    }, { materializeStart, activeServerDir: '/unused' });
    await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('\uD801'),
      credentials,
      pluginId: 'author.one',
    }, { materializeStart, activeServerDir: '/unused' });
    await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('\uD800'),
      credentials,
      pluginId: 'author.two',
    }, { materializeStart, activeServerDir: '/unused' });

    const firstKey = mocks.resolveExternalSessionPluginOperationPreflightAdmission.mock.calls[0]?.[0]
      .durableIdempotencyKey;
    const secondKey = mocks.resolveExternalSessionPluginOperationPreflightAdmission.mock.calls[1]?.[0]
      .durableIdempotencyKey;
    const thirdKey = mocks.resolveExternalSessionPluginOperationPreflightAdmission.mock.calls[2]?.[0]
      .durableIdempotencyKey;
    expect(firstKey).toMatch(/^plugin-operation:v1:[0-9a-f]{64}$/);
    expect(secondKey).toMatch(/^plugin-operation:v1:[0-9a-f]{64}$/);
    expect(firstKey).not.toBe(secondKey);
    expect(thirdKey).toMatch(/^plugin-operation:v1:[0-9a-f]{64}$/);
    expect(firstKey).not.toBe(thirdKey);
    expect(materializeStart).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'session-1',
      durableIdempotencyKey: firstKey,
      authorIntent: {
        v: 1,
        surface: 'plugin',
        kind: 'materialize',
        sessionId: 'session-1',
        targetStorageMode: 'external-linked',
      },
    }));
    expect(materializeStart).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'session-1',
      durableIdempotencyKey: secondKey,
    }));
    expect(materializeStart).toHaveBeenNthCalledWith(3, expect.objectContaining({
      sessionId: 'session-1',
      durableIdempotencyKey: thirdKey,
    }));
    expect(mocks.loadPersistedLinkedExternalSession).toHaveBeenCalledTimes(3);
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it('returns a changed-intent conflict only after current linked-Session authorization', async () => {
    mocks.resolveExternalSessionPluginOperationPreflightAdmission.mockResolvedValue({
      kind: 'conflict',
    });
    const materializeStart = vi.fn();

    const result = await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('\uD800'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir: '/unused' });

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Materialization idempotency request changed.',
        },
      },
    });
    expect(mocks.loadPersistedLinkedExternalSession).toHaveBeenCalledWith({
      credentials,
      sessionId: 'session-1',
    });
    expect(
      mocks.loadPersistedLinkedExternalSession.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.resolveExternalSessionPluginOperationPreflightAdmission
        .mock.invocationCallOrder[0]!,
    );
    expect(materializeStart).not.toHaveBeenCalled();
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });

  it('converges repeated same-plugin intent to the retained public operation reference', async () => {
    const retained = {
      operation: {
        sessionId: 'session-1',
        operationId: 'operation-retained',
        revision: 7,
      },
      presentation: {
        v: 1 as const,
        operationId: 'operation-retained',
        revision: 7,
        kind: 'materialize' as const,
        status: 'completed' as const,
        phase: 'publishing' as const,
      },
    };
    mocks.resolveExternalSessionPluginOperationPreflightAdmission.mockResolvedValue({
      kind: 'terminal_receipt',
      receipt: {
        reference: retained.operation,
        presentation: retained.presentation,
      },
    });
    const materializeStart = vi.fn();

    const first = await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('same-key'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir: '/unused' });
    const second = await executePluginExternalSessionAction({
      actionId: 'sessions.external.materialize.start',
      input: materializeInput('same-key'),
      credentials,
      pluginId: 'author.example',
    }, { materializeStart, activeServerDir: '/unused' });

    expect(first).toEqual({
      ok: true,
      result: {
        ok: true,
        operation: retained.operation,
      },
    });
    expect(first).not.toHaveProperty('result.presentation');
    expect(second).toEqual(first);
    expect(mocks.resolveExternalSessionPluginOperationPreflightAdmission.mock.calls[0]?.[0]
      .durableIdempotencyKey).toBe(
      mocks.resolveExternalSessionPluginOperationPreflightAdmission.mock.calls[1]?.[0]
        .durableIdempotencyKey,
    );
    expect(mocks.loadPersistedLinkedExternalSession).toHaveBeenCalledTimes(2);
    expect(materializeStart).not.toHaveBeenCalled();
    expect(mocks.callMachineRpc).not.toHaveBeenCalled();
  });
});

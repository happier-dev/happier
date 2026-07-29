import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSemanticRequestV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeExternalSessionOperationProgressProjection,
  assertExternalSessionOperationRecordAdmission,
  externalSessionOperationIdForRequest,
  listExternalSessionOperationRecords,
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';

const readFileBoundary = vi.hoisted(() => ({
  failurePath: null as string | null,
  syntheticInventory: null as Map<string, string> | null,
  observeRecordReads: false,
  recordReads: 0,
  recordBytes: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: (async (...args: Parameters<typeof actual.opendir>) => {
      if (
        readFileBoundary.syntheticInventory
        && String(args[0])
          .replaceAll('\\', '/')
          .endsWith('/external-session-operations/records')
      ) {
        const syntheticNames = [
          ...readFileBoundary.syntheticInventory.keys(),
        ];
        const syntheticNameSet = new Set(syntheticNames);
        const physicalEntries: Array<Readonly<{
          name: string;
          isFile: () => boolean;
        }>> = [];
        try {
          const physicalDirectory = await actual.opendir(...args);
          for await (const entry of physicalDirectory) {
            if (!syntheticNameSet.has(entry.name)) {
              physicalEntries.push({
                name: entry.name,
                isFile: () => entry.isFile(),
              });
            }
          }
        } catch (error) {
          if (
            !(error instanceof Error)
            || !('code' in error)
            || error.code !== 'ENOENT'
          ) {
            throw error;
          }
        }
        // Genuine filesystem boundary fixture: the store still performs its
        // real count, read, schema, and canonical-path admission logic.
        return {
          async *[Symbol.asyncIterator]() {
            for (const name of syntheticNames) {
              yield {
                name,
                isFile: () => true,
              };
            }
            for (const entry of physicalEntries) {
              yield entry;
            }
          },
        } as unknown as Awaited<ReturnType<typeof actual.opendir>>;
      }
      return await actual.opendir(...args);
    }) satisfies typeof actual.opendir,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (
        readFileBoundary.failurePath === 'record'
          && String(args[0]).endsWith('.json')
        || readFileBoundary.failurePath === '*'
        || String(args[0]) === readFileBoundary.failurePath
      ) {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      const pathParts = String(args[0]).replaceAll('\\', '/').split('/');
      const synthetic = readFileBoundary.syntheticInventory?.get(
        pathParts[pathParts.length - 1] ?? '',
      );
      const result = synthetic ?? await actual.readFile(...args);
      if (
        readFileBoundary.observeRecordReads
        && String(args[0]).endsWith('.json')
      ) {
        readFileBoundary.recordReads += 1;
        readFileBoundary.recordBytes += typeof result === 'string'
          ? Buffer.byteLength(result, 'utf8')
          : result.byteLength;
      }
      return result;
    },
  };
});

const roots: string[] = [];

const request = {
  v: 1,
  idempotencyKey: 'record-store-request-1',
  sessionId: 'session-1',
  source: {
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    qualifiedIdentity: {
      v: 1,
      agent: {
        pluginId: 'com.example.agent',
        localId: 'example',
      },
      source: {
        kind: 'jsonl',
      contractVersion: 1,
      },
    },
    linkGeneration: 'link-1',
    sourceGeneration: 'source-1',
    contributionGeneration: 'contribution-1',
  },
  plan: 'takeover',
  targetStorageMode: 'persisted',
  targetRuntimeMode: 'terminal',
} satisfies ExternalSessionOperationSemanticRequestV1;

function operationRecord(): ExternalSessionOperationRecordV1 {
  return {
    v: 1,
    operationId: externalSessionOperationIdForRequest(request),
    revision: 0,
    request,
    status: 'awaiting_user_resume',
    phase: 'validating',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 1,
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
    bindings: {
      operationClaimId: 'private-claim-1',
    },
    progressProjection: {
      acknowledgedRevision: null,
    },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 1,
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

function advancedOperationRecord(): ExternalSessionOperationRecordV1 {
  return {
    ...operationRecord(),
    revision: 1,
    status: 'running',
    phase: 'staging',
    updatedAtMs: 2,
    retryTargetPhase: undefined,
  };
}

function terminalOperationRecord(): ExternalSessionOperationRecordV1 {
  return {
    ...operationRecord(),
    revision: 1,
    status: 'discarded',
    updatedAtMs: 2,
    retryTargetPhase: undefined,
    terminalResult: { kind: 'discarded' },
  };
}

function pathForRecord(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(
    activeServerDir,
    'external-session-operations',
    'records',
    `${key}.json`,
  );
}

async function createRoot(): Promise<string> {
  const root = await fsPromises.mkdtemp(join(tmpdir(), 'happier-operation-record-store-'));
  roots.push(root);
  return root;
}

async function writeRawRecord(
  activeServerDir: string,
  operationId: string,
  contents: string,
): Promise<string> {
  const path = pathForRecord(activeServerDir, operationId);
  await fsPromises.mkdir(join(path, '..'), { recursive: true });
  await fsPromises.writeFile(path, contents, 'utf8');
  return path;
}

afterEach(async () => {
  readFileBoundary.failurePath = null;
  readFileBoundary.syntheticInventory = null;
  readFileBoundary.observeRecordReads = false;
  readFileBoundary.recordReads = 0;
  readFileBoundary.recordBytes = 0;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => {
    await fsPromises.rm(root, { recursive: true, force: true });
  }));
});

describe('external session operation record store integrity', () => {
  it('acknowledges a committed projection revision without changing semantic state', async () => {
    const activeServerDir = await createRoot();
    const record = advancedOperationRecord();
    await writeExternalSessionOperationRecord(activeServerDir, record);

    await expect(acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: record.operationId,
      projectedRevision: record.revision,
    })).resolves.toEqual({
      ...record,
      progressProjection: {
        acknowledgedRevision: record.revision,
      },
    });
    await expect(acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: record.operationId,
      projectedRevision: record.revision - 1,
    })).resolves.toEqual({
      ...record,
      progressProjection: {
        acknowledgedRevision: record.revision,
      },
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual({
      ...record,
      progressProjection: {
        acknowledgedRevision: record.revision,
      },
    });
  });

  it('rejects acknowledgement ahead of durable semantics with a typed failure', async () => {
    const activeServerDir = await createRoot();
    const record = operationRecord();
    await writeExternalSessionOperationRecord(activeServerDir, record);

    await expect(acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: record.operationId,
      projectedRevision: record.revision + 1,
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationProgressProjectionAcknowledgementError',
      reason: 'projected_revision_ahead',
      operationId: record.operationId,
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);
  });

  it('rejects invalid, missing, and mismatched acknowledgement targets with typed failures', async () => {
    const activeServerDir = await createRoot();
    const missingOperationId = 'external-takeover:missing-operation';

    await expect(acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: missingOperationId,
      projectedRevision: -1,
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationProgressProjectionAcknowledgementError',
      reason: 'invalid_projected_revision',
      operationId: missingOperationId,
    });
    await expect(acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: missingOperationId,
      projectedRevision: 0,
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationProgressProjectionAcknowledgementError',
      reason: 'operation_not_found',
      operationId: missingOperationId,
    });

    const record = operationRecord();
    await writeRawRecord(
      activeServerDir,
      missingOperationId,
      JSON.stringify(record),
    );
    await expect(acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: missingOperationId,
      projectedRevision: 0,
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationProgressProjectionAcknowledgementError',
      reason: 'operation_mismatch',
      operationId: missingOperationId,
    });
  });

  it('rejects semantic receipt regression and preserves the receipt on valid transitions', async () => {
    const activeServerDir = await createRoot();
    const initial = operationRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    await acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: initial.operationId,
      projectedRevision: initial.revision,
    });
    const acknowledged = await readExternalSessionOperationRecord(
      activeServerDir,
      initial.operationId,
    );
    if (!acknowledged) throw new Error('Expected acknowledged operation record.');

    await expect(writeExternalSessionOperationRecord(activeServerDir, {
      ...acknowledged,
      revision: acknowledged.revision + 1,
      status: 'running',
      updatedAtMs: acknowledged.updatedAtMs + 1,
      retryTargetPhase: undefined,
      progressProjection: {
        acknowledgedRevision: null,
      },
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordTransitionError',
      reason: 'progress_projection_regression',
    });

    const advanced = await mutateExternalSessionOperationRecordAtRevision(
      activeServerDir,
      acknowledged.operationId,
      acknowledged.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        status: 'running',
        updatedAtMs: current.updatedAtMs + 1,
        retryTargetPhase: undefined,
      }),
    );
    expect(advanced).toMatchObject({
      ok: true,
      record: {
        revision: acknowledged.revision + 1,
        progressProjection: {
          acknowledgedRevision: acknowledged.revision,
        },
      },
    });
    if (!advanced.ok) throw new Error('Expected semantic transition.');
    await expect(mutateExternalSessionOperationRecordAtRevision(
      activeServerDir,
      advanced.record.operationId,
      advanced.record.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAtMs: current.updatedAtMs + 1,
        progressProjection: {
          acknowledgedRevision: current.revision,
        },
      }),
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordTransitionError',
      reason: 'progress_projection_mismatch',
    });
  });

  it('returns null only when the canonical record is missing and creates it atomically', async () => {
    const activeServerDir = await createRoot();
    const record = operationRecord();

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toBeNull();
    await expect(listExternalSessionOperationRecords(activeServerDir)).resolves.toEqual([]);
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      record,
    )).resolves.toEqual(record);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);
    await expect(listExternalSessionOperationRecords(activeServerDir)).resolves.toEqual([record]);
  });

  it('reconciles only the current-dev record shape that predates the projection receipt', async () => {
    const activeServerDir = await createRoot();
    const record = operationRecord();
    const {
      progressProjection: _progressProjection,
      ...currentDevRecord
    } = record;
    await writeRawRecord(
      activeServerDir,
      record.operationId,
      JSON.stringify(currentDevRecord),
    );

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);
  });

  it.each([
    ['malformed_json', '{"v":'],
    ['invalid_record', JSON.stringify({ v: 1 })],
  ] as const)(
    'rejects %s and never replaces the corrupt canonical record',
    async (reason, contents) => {
      const activeServerDir = await createRoot();
      const record = operationRecord();
      const path = await writeRawRecord(activeServerDir, record.operationId, contents);

      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).rejects.toMatchObject({
        name: 'ExternalSessionOperationRecordReadError',
        reason,
      });
      await expect(writeExternalSessionOperationRecord(
        activeServerDir,
        record,
      )).rejects.toMatchObject({
        name: 'ExternalSessionOperationRecordReadError',
        reason,
      });
      await expect(mutateExternalSessionOperationRecordAtRevision(
        activeServerDir,
        record.operationId,
        0,
        (current) => ({ ...current, revision: 1 }),
      )).rejects.toMatchObject({
        name: 'ExternalSessionOperationRecordReadError',
        reason,
      });
      await expect(fsPromises.readFile(path, 'utf8')).resolves.toBe(contents);
    },
  );

  it('rejects a schema-valid record stored under the wrong canonical identity', async () => {
    const activeServerDir = await createRoot();
    const record = operationRecord();
    const mismatched = {
      ...record,
      operationId: 'external-takeover:different-operation-identity',
    } satisfies ExternalSessionOperationRecordV1;
    const contents = JSON.stringify(mismatched);
    const path = await writeRawRecord(
      activeServerDir,
      record.operationId,
      contents,
    );

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'invalid_record',
    });
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      record,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'invalid_record',
    });
    await expect(fsPromises.readFile(path, 'utf8')).resolves.toBe(contents);
  });

  it('surfaces an OS read failure and performs no replacement write', async () => {
    const activeServerDir = await createRoot();
    const record = operationRecord();
    const path = await writeRawRecord(
      activeServerDir,
      record.operationId,
      JSON.stringify(record),
    );
    readFileBoundary.failurePath = 'record';

    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      { ...record, revision: 1 },
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'read_failed',
    });

    readFileBoundary.failurePath = null;
    await expect(fsPromises.readFile(path, 'utf8')).resolves.toBe(JSON.stringify(record));
  });

  it('keeps the same valid semantic operation idempotent', async () => {
    const activeServerDir = await createRoot();
    const record = operationRecord();

    await writeExternalSessionOperationRecord(activeServerDir, record);
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      record,
    )).resolves.toEqual(record);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);
  });

  it.each([
    {
      name: 'same-revision unequal replacement',
      expectedError: 'external_session_operation_record_stale_revision',
      current: advancedOperationRecord(),
      next: (current: ExternalSessionOperationRecordV1) => ({
        ...current,
        updatedAtMs: current.updatedAtMs + 1,
      }),
    },
    {
      name: 'revision gap',
      expectedError: 'external_session_operation_record_revision_gap',
      current: advancedOperationRecord(),
      next: (current: ExternalSessionOperationRecordV1) => ({
        ...current,
        revision: current.revision + 2,
        updatedAtMs: current.updatedAtMs + 1,
      }),
    },
    {
      name: 'semantic request mutation',
      expectedError: 'external_session_operation_record_semantic_mismatch',
      current: advancedOperationRecord(),
      next: (current: ExternalSessionOperationRecordV1) => ({
        ...current,
        revision: current.revision + 1,
        request: {
          ...current.request,
          source: {
            ...current.request.source,
            remoteSessionId: 'changed-remote-session',
          },
        },
        updatedAtMs: current.updatedAtMs + 1,
      }),
    },
    {
      name: 'updated-at regression',
      expectedError: 'external_session_operation_record_updated_at_regression',
      current: advancedOperationRecord(),
      next: (current: ExternalSessionOperationRecordV1) => ({
        ...current,
        revision: current.revision + 1,
        updatedAtMs: current.updatedAtMs - 1,
      }),
    },
    {
      name: 'phase regression',
      expectedError: 'external_session_operation_record_phase_regression',
      current: advancedOperationRecord(),
      next: (current: ExternalSessionOperationRecordV1) => ({
        ...current,
        revision: current.revision + 1,
        phase: 'validating' as const,
        updatedAtMs: current.updatedAtMs + 1,
      }),
    },
    {
      name: 'terminal mutation',
      expectedError: 'external_session_operation_record_terminal_operation',
      current: terminalOperationRecord(),
      next: (current: ExternalSessionOperationRecordV1) => ({
        ...current,
        revision: current.revision + 1,
        updatedAtMs: current.updatedAtMs + 1,
      }),
    },
  ])(
    'rejects a $name through both locked update entry points without replacing the record',
    async ({ current, next, expectedError }) => {
      const activeServerDir = await createRoot();
      const incoming = next(current) satisfies ExternalSessionOperationRecordV1;
      await writeExternalSessionOperationRecord(activeServerDir, current);

      await expect(writeExternalSessionOperationRecord(
        activeServerDir,
        incoming,
      )).rejects.toThrow(expectedError);
      await expect(mutateExternalSessionOperationRecordAtRevision(
        activeServerDir,
        current.operationId,
        current.revision,
        () => incoming,
      )).rejects.toThrow(expectedError);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        current.operationId,
      )).resolves.toEqual(current);
    },
  );

  it('rejects an operation identity mutation under the mutation lock', async () => {
    const activeServerDir = await createRoot();
    const current = advancedOperationRecord();
    await writeExternalSessionOperationRecord(activeServerDir, current);

    await expect(mutateExternalSessionOperationRecordAtRevision(
      activeServerDir,
      current.operationId,
      current.revision,
      (record) => ({
        ...record,
        operationId: 'external-takeover:changed-operation',
        revision: record.revision + 1,
        updatedAtMs: record.updatedAtMs + 1,
      }),
    )).rejects.toThrow('external_session_operation_record_operation_mismatch');
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      current.operationId,
    )).resolves.toEqual(current);
  });

  it('accepts an exact duplicate through both locked update entry points', async () => {
    const activeServerDir = await createRoot();
    const current = advancedOperationRecord();
    await writeExternalSessionOperationRecord(activeServerDir, current);

    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      current,
    )).resolves.toEqual(current);
    await expect(mutateExternalSessionOperationRecordAtRevision(
      activeServerDir,
      current.operationId,
      current.revision,
      (record) => record,
    )).resolves.toEqual({ ok: true, record: current });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      current.operationId,
    )).resolves.toEqual(current);
  });

  it('runs session admission under the store owner before creating a cross-operation row', async () => {
    const activeServerDir = await createRoot();
    const nextRequest = {
      ...request,
      idempotencyKey: 'record-store-request-2',
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const nextRecord = {
      ...operationRecord(),
      operationId: externalSessionOperationIdForRequest(nextRequest),
      request: nextRequest,
    } satisfies ExternalSessionOperationRecordV1;
    const validateSessionAdmission = vi.fn(async (
      current: ExternalSessionOperationRecordV1 | null,
      incoming: ExternalSessionOperationRecordV1,
    ) => {
      expect(current).toBeNull();
      expect(incoming).toEqual(nextRecord);
      throw new Error('external_session_operation_projection_conflict');
    });

    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      nextRecord,
      { validateSessionAdmission },
    )).rejects.toThrow('external_session_operation_projection_conflict');
    expect(validateSessionAdmission).toHaveBeenCalledOnce();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      nextRecord.operationId,
    )).resolves.toBeNull();
  });

  it('settles the prior terminal projection receipt before committing a successor', async () => {
    const activeServerDir = await createRoot();
    const prior = terminalOperationRecord();
    const nextRequest = {
      ...request,
      idempotencyKey: 'record-store-successor-request',
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const successor = {
      ...operationRecord(),
      operationId: externalSessionOperationIdForRequest(nextRequest),
      request: nextRequest,
    } satisfies ExternalSessionOperationRecordV1;
    await writeExternalSessionOperationRecord(activeServerDir, prior);
    const settlePriorTerminalProgressProjection = vi.fn(async (
      priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
    ) => {
      expect(priorTerminalRecords).toEqual([prior]);
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: prior.operationId,
        projectedRevision: prior.revision,
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        successor.operationId,
      )).resolves.toBeNull();
    });

    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      successor,
      { settlePriorTerminalProgressProjection },
    )).resolves.toEqual(successor);
    expect(settlePriorTerminalProgressProjection).toHaveBeenCalledOnce();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      prior.operationId,
    )).resolves.toEqual({
      ...prior,
      progressProjection: {
        acknowledgedRevision: prior.revision,
      },
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      successor.operationId,
    )).resolves.toEqual(successor);
  });

  it('blocks a hidden nonterminal operation before exclusion and repeats the fence before write', async () => {
    const activeServerDir = await createRoot();
    const hidden = operationRecord();
    const nextRequest = {
      ...request,
      idempotencyKey: 'record-store-request-2',
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const nextRecord = {
      ...hidden,
      operationId: externalSessionOperationIdForRequest(nextRequest),
      request: nextRequest,
    } satisfies ExternalSessionOperationRecordV1;
    await writeExternalSessionOperationRecord(activeServerDir, hidden);

    await expect(assertExternalSessionOperationRecordAdmission(
      activeServerDir,
      {
        sessionId: nextRequest.sessionId,
        operationId: nextRecord.operationId,
        idempotencyKey: nextRequest.idempotencyKey,
      },
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      nextRecord,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      nextRecord.operationId,
    )).resolves.toBeNull();
  });

  it('does not let the same idempotency key evade durable admission by changing plan after restart', async () => {
    const activeServerDir = await createRoot();
    const takeover = terminalOperationRecord();
    const changedPlanRequest = {
      ...request,
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const changedPlan = {
      ...takeover,
      operationId: externalSessionOperationIdForRequest(changedPlanRequest),
      request: changedPlanRequest,
      timeline: resolveExternalSessionOperationTimelineV1(changedPlanRequest),
    } satisfies ExternalSessionOperationRecordV1;
    await writeExternalSessionOperationRecord(activeServerDir, takeover);

    expect(changedPlan.operationId).not.toBe(takeover.operationId);
    await expect(assertExternalSessionOperationRecordAdmission(
      activeServerDir,
      {
        sessionId: changedPlanRequest.sessionId,
        operationId: changedPlan.operationId,
        idempotencyKey: changedPlanRequest.idempotencyKey,
      },
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      changedPlan,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      changedPlan.operationId,
    )).resolves.toBeNull();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      takeover.operationId,
    )).resolves.toEqual(takeover);
  });

  it('fails closed when the bounded admission inventory contains an unreadable row', async () => {
    const activeServerDir = await createRoot();
    const nextRecord = operationRecord();
    await writeRawRecord(
      activeServerDir,
      'unknown-corrupt-operation',
      '{"v":',
    );

    await expect(assertExternalSessionOperationRecordAdmission(
      activeServerDir,
      {
        sessionId: nextRecord.request.sessionId,
        operationId: nextRecord.operationId,
        idempotencyKey: nextRecord.request.idempotencyKey,
      },
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'inventory_unreadable',
    });
    await expect(listExternalSessionOperationRecords(
      activeServerDir,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'inventory_unreadable',
    });
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      nextRecord,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'inventory_unreadable',
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      nextRecord.operationId,
    )).resolves.toBeNull();
  });

  it('refuses a new 10,001st record while the full inventory remains readable and existing operations remain writable', async () => {
    const activeServerDir = await createRoot();
    const base = terminalOperationRecord();
    const syntheticInventory = new Map<string, string>();
    for (let index = 0; index < 10_000; index += 1) {
      const operationId =
        `external-takeover:inventory-${String(index).padStart(5, '0')}`;
      const record = index === 0
        ? {
            ...operationRecord(),
            operationId,
          } satisfies ExternalSessionOperationRecordV1
        : {
            ...base,
            operationId,
          } satisfies ExternalSessionOperationRecordV1;
      syntheticInventory.set(
        basename(pathForRecord(activeServerDir, operationId)),
        JSON.stringify(record),
      );
    }
    readFileBoundary.syntheticInventory = syntheticInventory;
    readFileBoundary.observeRecordReads = true;

    const incomingRequest = {
      ...request,
      sessionId: 'unrelated-session',
      idempotencyKey: 'over-limit-attempt',
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const incoming = {
      ...operationRecord(),
      operationId: externalSessionOperationIdForRequest(incomingRequest),
      request: incomingRequest,
    } satisfies ExternalSessionOperationRecordV1;
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      incoming,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'inventory_too_large',
    });
    expect(readFileBoundary.recordReads).toBe(10_000);
    await expect(fsPromises.stat(
      pathForRecord(activeServerDir, incoming.operationId),
    )).rejects.toMatchObject({ code: 'ENOENT' });

    const existingOperationId = 'external-takeover:inventory-00000';
    const current = {
      ...operationRecord(),
      operationId: existingOperationId,
    } satisfies ExternalSessionOperationRecordV1;
    const next = {
      ...advancedOperationRecord(),
      operationId: existingOperationId,
    } satisfies ExternalSessionOperationRecordV1;
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      existingOperationId,
    )).resolves.toEqual(current);
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      next,
    )).resolves.toEqual(next);
    await expect(fsPromises.stat(
      pathForRecord(activeServerDir, existingOperationId),
    )).resolves.toBeDefined();
    syntheticInventory.set(
      basename(pathForRecord(activeServerDir, existingOperationId)),
      JSON.stringify(next),
    );
    await expect(listExternalSessionOperationRecords(
      activeServerDir,
    )).resolves.toHaveLength(10_000);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      existingOperationId,
    )).resolves.toEqual(next);
  });

  it('serializes different-session admission at the global inventory ceiling', async () => {
    const activeServerDir = await createRoot();
    const base = terminalOperationRecord();
    const syntheticInventory = new Map<string, string>();
    for (let index = 0; index < 9_999; index += 1) {
      const operationId =
        `external-takeover:concurrent-inventory-${String(index).padStart(5, '0')}`;
      syntheticInventory.set(
        basename(pathForRecord(activeServerDir, operationId)),
        JSON.stringify({
          ...base,
          operationId,
        } satisfies ExternalSessionOperationRecordV1),
      );
    }
    readFileBoundary.syntheticInventory = syntheticInventory;

    const incomingRecords = ['a', 'b'].map((suffix) => {
      const incomingRequest = {
        ...request,
        sessionId: `concurrent-session-${suffix}`,
        idempotencyKey: `concurrent-key-${suffix}`,
      } satisfies ExternalSessionOperationSemanticRequestV1;
      return {
        ...operationRecord(),
        operationId: externalSessionOperationIdForRequest(incomingRequest),
        request: incomingRequest,
      } satisfies ExternalSessionOperationRecordV1;
    });

    const results = await Promise.allSettled(
      incomingRecords.map(
        (record) => writeExternalSessionOperationRecord(
          activeServerDir,
          record,
        ),
      ),
    );
    expect(results.filter(
      (result) => result.status === 'fulfilled',
    )).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'inventory_too_large',
    });

    const records = await listExternalSessionOperationRecords(activeServerDir);
    expect(records).toHaveLength(10_000);
    const admitted = incomingRecords.filter((incoming) =>
      records.some((record) => record.operationId === incoming.operationId)
    );
    expect(admitted).toHaveLength(1);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      admitted[0]!.operationId,
    )).resolves.toEqual(admitted[0]);
  });

  it('retains replaced terminal idempotency identity and rejects its later semantic reuse', async () => {
    const activeServerDir = await createRoot();
    const initial = operationRecord();
    const terminalRequest = {
      ...request,
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const {
      retryTargetPhase: _retryTargetPhase,
      ...initialWithoutRetry
    } = initial;
    const terminal = {
      ...initialWithoutRetry,
      operationId: externalSessionOperationIdForRequest(terminalRequest),
      request: terminalRequest,
      status: 'completed',
      phase: 'publishing',
      timeline: resolveExternalSessionOperationTimelineV1(terminalRequest),
      currentStorageState: 'snapshot_complete',
      checkpoint: {
        ...initial.checkpoint,
        acceptedThroughServerSeq: 0,
        acknowledgedBatchId: 'historical-import-complete',
      },
      bindings: {
        ...initial.bindings,
        historicalImportJobId: 'historical-import-1',
      },
      canonicalOwnerEvidence: {
        linkedSessionRevision: 1,
        sourceSnapshotEvidenceRef: 'source-revision-1',
      },
      publication: {
        materializationPublicationId: 'publication-1',
        materializedThroughSourceAt: 1,
        publishedThroughServerSeq: 0,
      },
      terminalResult: { kind: 'completed' },
    } satisfies ExternalSessionOperationRecordV1;
    const nextRequest = {
      ...request,
      idempotencyKey: 'record-store-request-2',
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const next = {
      ...terminalOperationRecord(),
      operationId: externalSessionOperationIdForRequest(nextRequest),
      request: nextRequest,
    } satisfies ExternalSessionOperationRecordV1;

    await writeExternalSessionOperationRecord(activeServerDir, terminal);
    await writeExternalSessionOperationRecord(activeServerDir, next);

    await expect(assertExternalSessionOperationRecordAdmission(
      activeServerDir,
      {
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        idempotencyKey: initial.request.idempotencyKey,
      },
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      initial,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      next.operationId,
    )).resolves.toEqual(next);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      terminal.operationId,
    )).resolves.toEqual(terminal);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      initial.operationId,
    )).resolves.toBeNull();
  });
});

describe.runIf(process.env.HAPPIER_RUN_EXTERNAL_SESSION_BENCHMARK === '1')(
  'External Sessions operation-record inventory benchmark',
  () => {
    type PhaseMeasurement = Readonly<{
      elapsedMs: number;
      recordReads: number;
      recordBytes: number;
      heapUsedBeforeBytes: number;
      heapUsedAfterBytes: number;
      heapUsedDeltaBytes: number;
      rssBeforeBytes: number;
      rssAfterBytes: number;
      rssDeltaBytes: number;
    }>;

    function roundMilliseconds(value: number): number {
      return Math.round(value * 100) / 100;
    }

    async function measurePhase<T>(
      operation: () => Promise<T> | T,
    ): Promise<Readonly<{ value: T; measurement: PhaseMeasurement }>> {
      readFileBoundary.recordReads = 0;
      readFileBoundary.recordBytes = 0;
      const memoryBefore = process.memoryUsage();
      const startedAt = performance.now();
      const value = await operation();
      const elapsedMs = performance.now() - startedAt;
      const memoryAfter = process.memoryUsage();
      return {
        value,
        measurement: {
          elapsedMs: roundMilliseconds(elapsedMs),
          recordReads: readFileBoundary.recordReads,
          recordBytes: readFileBoundary.recordBytes,
          heapUsedBeforeBytes: memoryBefore.heapUsed,
          heapUsedAfterBytes: memoryAfter.heapUsed,
          heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
          rssBeforeBytes: memoryBefore.rss,
          rssAfterBytes: memoryAfter.rss,
          rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
        },
      };
    }

    function terminalBenchmarkRecord(
      index: number,
    ): ExternalSessionOperationRecordV1 {
      const base = terminalOperationRecord();
      const suffix = String(index).padStart(5, '0');
      return {
        ...base,
        operationId: `external-takeover:benchmark-${suffix}`,
        request: {
          ...base.request,
          sessionId: index === 9_999
            ? 'benchmark-late-conflict-session'
            : `benchmark-session-${suffix}`,
          idempotencyKey: index === 9_999
            ? 'benchmark-late-conflict-key'
            : `benchmark-key-${suffix}`,
        },
      };
    }

    it('measures the retained 10,000-file global inventory without timing thresholds', async () => {
      const activeServerDir = await createRoot();
      const directoryPath = join(
        activeServerDir,
        'external-session-operations',
        'records',
      );
      await fsPromises.mkdir(directoryPath, { recursive: true, mode: 0o700 });

      const records = Array.from(
        { length: 10_000 },
        (_, index) => terminalBenchmarkRecord(index),
      );
      const serializedRecords = records.map((record) => {
        const serialized = JSON.stringify(record);
        return {
          path: pathForRecord(activeServerDir, record.operationId),
          serialized,
        };
      });
      for (let offset = 0; offset < serializedRecords.length; offset += 250) {
        await Promise.all(
          serializedRecords.slice(offset, offset + 250).map(
            async ({ path, serialized }) => {
              await fsPromises.writeFile(path, serialized, {
                encoding: 'utf8',
                mode: 0o600,
              });
            },
          ),
        );
      }
      const aggregateRecordBytes = serializedRecords.reduce(
        (sum, { serialized }) => sum + Buffer.byteLength(serialized, 'utf8'),
        0,
      );
      readFileBoundary.observeRecordReads = true;

      const coldList = await measurePhase(
        () => listExternalSessionOperationRecords(activeServerDir),
      );
      expect(coldList.value).toHaveLength(10_000);

      const warmList = await measurePhase(async () => (
        await listExternalSessionOperationRecords(activeServerDir)
      ).length);
      expect(warmList.value).toBe(10_000);

      const {
        repairExternalSessionOperationProgressProjections,
        selectExternalSessionOperationRecordsForPassiveRepair,
      } = await import('./operationProgressPublisher');
      const passiveSelection = await measurePhase(
        () => selectExternalSessionOperationRecordsForPassiveRepair(
          coldList.value,
        ),
      );
      expect(passiveSelection.value).toEqual([]);

      const passiveBoot = await measurePhase(
        () => repairExternalSessionOperationProgressProjections(
          activeServerDir,
          {
            publish: async () => {
              throw new Error(
                'terminal-only benchmark inventory must not publish progress',
              );
            },
          },
        ),
      );
      expect(passiveBoot.value).toBe(0);

      const removed = serializedRecords[0]!;
      await fsPromises.rm(removed.path);
      const lateConflict = await measurePhase(async () => {
        await expect(assertExternalSessionOperationRecordAdmission(
          activeServerDir,
          {
            sessionId: 'benchmark-late-conflict-session',
            operationId: 'external-takeover:benchmark-late-conflict-attempt',
            idempotencyKey: 'benchmark-late-conflict-key',
          },
        )).rejects.toMatchObject({
          name: 'ExternalSessionOperationRecordAdmissionError',
          reason: 'conflicting_operation',
        });
      });

      const incomingRequest = {
        ...request,
        sessionId: 'benchmark-fresh-unrelated-session',
        idempotencyKey: 'benchmark-fresh-unrelated-key',
      } satisfies ExternalSessionOperationSemanticRequestV1;
      const incomingRecord = {
        ...terminalOperationRecord(),
        operationId: externalSessionOperationIdForRequest(incomingRequest),
        request: incomingRequest,
      } satisfies ExternalSessionOperationRecordV1;
      const freshAdmission = await measurePhase(async () => {
        await assertExternalSessionOperationRecordAdmission(
          activeServerDir,
          {
            sessionId: incomingRequest.sessionId,
            operationId: incomingRecord.operationId,
            idempotencyKey: incomingRequest.idempotencyKey,
          },
        );
        await writeExternalSessionOperationRecord(
          activeServerDir,
          incomingRecord,
        );
      });

      const overLimit = terminalBenchmarkRecord(10_000);
      const overLimitSerialized = JSON.stringify(overLimit);
      await fsPromises.writeFile(
        pathForRecord(activeServerDir, overLimit.operationId),
        overLimitSerialized,
        { encoding: 'utf8', mode: 0o600 },
      );
      const failClosed = await measurePhase(async () => {
        await expect(listExternalSessionOperationRecords(
          activeServerDir,
        )).rejects.toMatchObject({
          name: 'ExternalSessionOperationRecordAdmissionError',
          reason: 'inventory_too_large',
        });
      });

      process.stdout.write(
        `EXTERNAL_SESSION_OPERATION_INVENTORY_J14 ${JSON.stringify({
          environment: {
            node: process.versions.node,
            platform: platform(),
            arch: arch(),
            cpuModel: cpus()[0]?.model ?? 'unknown',
            logicalCpuCount: cpus().length,
            gcExposed: typeof globalThis.gc === 'function',
          },
          corpus: {
            recordCount: records.length,
            aggregateRecordBytes,
            averageRecordBytes: Math.round(
              aggregateRecordBytes / records.length,
            ),
          },
          phases: {
            coldList: coldList.measurement,
            warmList: warmList.measurement,
            terminalOnlyPassiveSelection: passiveSelection.measurement,
            passiveBootRepair: passiveBoot.measurement,
            freshUnrelatedStartTwoScans: freshAdmission.measurement,
            lateSameSessionConflict: lateConflict.measurement,
            tenThousandAndOneFailClosed: failClosed.measurement,
          },
          notes: {
            coldList:
              'first store scan in this process after direct writes; kernel file cache was not purged',
            memory:
              'endpoint process.memoryUsage samples without forced GC; deltas are directional, not retained-heap proofs',
            freshStart:
              'one explicit preflight scan plus the canonical write-time scan under admission locks',
          },
        })}\n`,
      );
    }, 120_000);
  },
);

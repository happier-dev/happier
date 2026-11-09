import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  ExternalSessionOperationRecordV1Schema,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSemanticRequestV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';

import {
  abandonExternalSessionOperationsForDeletedSession,
  acknowledgeExternalSessionOperationProgressProjection,
  assertExternalSessionOperationRecordAdmission,
  compactExternalSessionOperationRecordToTerminalReceipt,
  listExternalSessionOperationRecords,
  mutateExternalSessionOperationRecordAtRevision,
  projectExternalSessionTakeoverIdempotencyIntent,
  readExternalSessionOperationRecord,
  readExternalSessionOperationStoredEntry,
  resolveExternalSessionOperationAccountScope,
  resolveExternalSessionPluginOperationPreflightAdmission,
  resolveExternalSessionOperationStartAdmission,
  type ExternalSessionOperationTerminalReceiptV1,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';

const accountCredentials = vi.hoisted(() => ({
  current: null as Readonly<{ token: string; encryption: null }> | null,
  reads: 0,
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: async () => {
    accountCredentials.reads += 1;
    return accountCredentials.current;
  },
}));

const readFileBoundary = vi.hoisted(() => ({
  failurePath: null as string | null,
  syntheticInventory: null as Map<string, string> | null,
  syntheticInventoryDirectories: null as readonly string[] | null,
  observeRecordReads: false,
  recordReads: 0,
  recordBytes: 0,
  observeReadConcurrency: false,
  inFlightRecordReads: 0,
  peakInFlightRecordReads: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: (async (...args: Parameters<typeof actual.opendir>) => {
      const normalizedDirectory = String(args[0]).replaceAll('\\', '/');
      if (
        readFileBoundary.syntheticInventory
        && (
          normalizedDirectory.endsWith(accountRecordDirectorySuffix('vitest'))
          || readFileBoundary.syntheticInventoryDirectories?.some(
            (directory) => normalizedDirectory.endsWith(directory),
          )
        )
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
      const observesConcurrency = readFileBoundary.observeReadConcurrency
        && String(args[0]).endsWith('.json');
      if (observesConcurrency) {
        readFileBoundary.inFlightRecordReads += 1;
        readFileBoundary.peakInFlightRecordReads = Math.max(
          readFileBoundary.peakInFlightRecordReads,
          readFileBoundary.inFlightRecordReads,
        );
        // A genuine asynchronous settle at the filesystem boundary, so an
        // overlapping read is observable: a reader that awaits each row in
        // turn can never raise the in-flight count above one.
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      try {
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
      } finally {
        if (observesConcurrency) {
          readFileBoundary.inFlightRecordReads -= 1;
        }
      }
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
    sourceCustody: { kind: 'development', registeredRootId: 'contribution-1' },
  },
  plan: 'takeover',
  targetStorageMode: 'persisted',
  targetDirectory: '/local/selected/workspace',
  targetRuntimeMode: 'terminal',
} satisfies ExternalSessionOperationSemanticRequestV1;

function operationRecord(): ExternalSessionOperationRecordV1 {
  return {
    v: 1,
    operationId: 'external-takeover:record-store-base-fixture',
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

function completedExternalLinkedOperationRecord(): ExternalSessionOperationRecordV1 {
  const externalLinkedRequest = {
    ...request,
    targetStorageMode: 'external-linked' as const,
  };
  const terminalAtMs = 25_000;
  return ExternalSessionOperationRecordV1Schema.parse({
    ...operationRecord(),
    operationId:
      'external-takeover:record-store-completed-external-linked-fixture',
    revision: 6,
    request: externalLinkedRequest,
    status: 'completed',
    phase: 'finalizing',
    timeline: resolveExternalSessionOperationTimelineV1(externalLinkedRequest),
    updatedAtMs: terminalAtMs,
    progressProjection: { acknowledgedRevision: 6 },
    retryTargetPhase: undefined,
    terminalResult: { kind: 'completed' },
  });
}

function cancelledInitialPartialMaterializeRecord(): ExternalSessionOperationRecordV1 {
  const { targetDirectory: _targetDirectory, ...materializeRequestBase } = request;
  const materializeRequest = {
    ...materializeRequestBase,
    idempotencyKey: 'record-store-cancelled-initial-partial',
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
  } satisfies ExternalSessionOperationSemanticRequestV1;
  return ExternalSessionOperationRecordV1Schema.parse({
    ...operationRecord(),
    operationId: 'external-materialize:cancelled-initial-partial-fixture',
    revision: 3,
    request: materializeRequest,
    status: 'cancelled',
    phase: 'importing',
    timeline: resolveExternalSessionOperationTimelineV1(materializeRequest),
    updatedAtMs: 4,
    currentStorageState: 'server_partial',
    checkpoint: {
      sourcePagesRead: 1,
      stagedItemCount: 1,
      importedItemCount: 1,
      acceptedThroughServerSeq: 3,
      acknowledgedBatchId: 'initial-partial-batch',
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
      operationClaimId: 'initial-partial-claim',
      historicalImportJobId: 'initial-partial-job',
    },
    progressProjection: { acknowledgedRevision: 3 },
    fence: { kind: 'initial_server_partial', acceptedThroughServerSeq: 3 },
    cancellation: {
      requestedAtMs: 3,
      requestedAtRevision: 2,
    },
    retryTargetPhase: undefined,
    terminalResult: { kind: 'cancelled' },
  });
}

function cancelledLocalPrivateCaptureMaterializeRecord(): ExternalSessionOperationRecordV1 {
  const { targetDirectory: _targetDirectory, ...materializeRequestBase } = request;
  const materializeRequest = {
    ...materializeRequestBase,
    idempotencyKey: 'record-store-cancelled-local-private-capture',
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
  } satisfies ExternalSessionOperationSemanticRequestV1;
  return ExternalSessionOperationRecordV1Schema.parse({
    ...operationRecord(),
    operationId: 'external-materialize:cancelled-local-private-capture-fixture',
    revision: 3,
    request: materializeRequest,
    status: 'cancelled',
    phase: 'staging',
    timeline: resolveExternalSessionOperationTimelineV1(materializeRequest),
    updatedAtMs: 4,
    progressProjection: { acknowledgedRevision: 3 },
    cancellation: {
      requestedAtMs: 3,
      requestedAtRevision: 2,
    },
    retryTargetPhase: undefined,
    terminalResult: { kind: 'cancelled' },
  });
}

function pluginTakeoverAuthorIntent(
  remoteSessionId = 'remote-1',
  targetStorageMode: 'external-linked' | 'persisted' = 'persisted',
) {
  return {
    v: 1 as const,
    surface: 'plugin' as const,
    kind: 'takeover' as const,
    agentId: 'example',
    sourceId: 'codexHome:user:::',
    remoteSessionId,
    targetStorageMode,
  };
}

function pluginTakeoverRecord(input: Readonly<{
  operationId: string;
  sessionId: string;
  durableIdempotencyKey: string;
  authorIntent: ReturnType<typeof pluginTakeoverAuthorIntent>;
}>): ExternalSessionOperationRecordV1 {
  const semanticRequest = {
    ...request,
    sessionId: input.sessionId,
    idempotencyKey: input.durableIdempotencyKey,
    source: {
      ...request.source,
      remoteSessionId: input.authorIntent.remoteSessionId,
    },
    targetStorageMode: input.authorIntent.targetStorageMode,
  } satisfies ExternalSessionOperationSemanticRequestV1;
  return ExternalSessionOperationRecordV1Schema.parse({
    ...operationRecord(),
    operationId: input.operationId,
    request: semanticRequest,
    timeline: resolveExternalSessionOperationTimelineV1(semanticRequest),
    authorIntent: input.authorIntent,
  });
}

function pluginMaterializeRecord(input: Readonly<{
  operationId: string;
  sessionId: string;
  durableIdempotencyKey: string;
}>): ExternalSessionOperationRecordV1 {
  const { targetDirectory: _targetDirectory, ...materializeRequest } = request;
  const semanticRequest = {
    ...materializeRequest,
    sessionId: input.sessionId,
    idempotencyKey: input.durableIdempotencyKey,
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
  } satisfies ExternalSessionOperationSemanticRequestV1;
  return ExternalSessionOperationRecordV1Schema.parse({
    ...operationRecord(),
    operationId: input.operationId,
    request: semanticRequest,
    timeline: resolveExternalSessionOperationTimelineV1(semanticRequest),
    authorIntent: {
      v: 1,
      surface: 'plugin',
      kind: 'materialize',
      sessionId: input.sessionId,
      targetStorageMode: 'external-linked',
    },
  });
}

function pathForRecord(activeServerDir: string, operationId: string): string {
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

function legacyPathForRecord(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(
    activeServerDir,
    'external-session-operations',
    'records',
    `${key}.json`,
  );
}

function accountRecordDirectorySuffix(subject: string): string {
  const accountKey = createHash('sha256').update(subject, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `/external-session-operations/by-account/sub-${accountKey}/records`;
}

function accountToken(subject: string, marker: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value))
    .toString('base64url');
  return `${encode({ alg: 'none', marker })}.${encode({ sub: subject, marker })}.`;
}

function useAccount(subject: string, marker = 'initial'): void {
  accountCredentials.current = {
    token: accountToken(subject, marker),
    encryption: null,
  };
}

/**
 * The record-store fixtures run without persisted credentials, so the pure
 * ambient fallback partition subject is 'vitest'. Deletion fixtures pin it
 * explicitly because abandonment requires the deletion fact's owning Account
 * scope.
 */
function vitestAmbientAccountScope(
  activeServerDir: string,
): { activeServerDir: string; accountSubject: string } {
  return { activeServerDir, accountSubject: 'vitest' };
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

async function writeRawLegacyRecord(
  activeServerDir: string,
  operationId: string,
  contents: string,
): Promise<string> {
  const path = legacyPathForRecord(activeServerDir, operationId);
  await fsPromises.mkdir(join(path, '..'), { recursive: true });
  await fsPromises.writeFile(path, contents, 'utf8');
  return path;
}

afterEach(async () => {
  accountCredentials.current = null;
  readFileBoundary.failurePath = null;
  readFileBoundary.syntheticInventory = null;
  readFileBoundary.syntheticInventoryDirectories = null;
  readFileBoundary.observeRecordReads = false;
  readFileBoundary.recordReads = 0;
  readFileBoundary.recordBytes = 0;
  readFileBoundary.observeReadConcurrency = false;
  readFileBoundary.inFlightRecordReads = 0;
  readFileBoundary.peakInFlightRecordReads = 0;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => {
    await fsPromises.rm(root, { recursive: true, force: true });
  }));
});

describe('external session operation record store integrity', () => {
  it('abandons every matching full record for the authoritatively deleted Session, terminal or not', async () => {
    const activeServerDir = await createRoot();
    const deletedSessionRecord = ExternalSessionOperationRecordV1Schema.parse({
      ...advancedOperationRecord(),
      operationId: 'external-takeover:deleted-session-operation',
      request: {
        ...advancedOperationRecord().request,
        idempotencyKey: 'deleted-session-operation',
        sessionId: 'session-deleted',
      },
    });
    const otherSessionRecord = ExternalSessionOperationRecordV1Schema.parse({
      ...advancedOperationRecord(),
      operationId: 'external-takeover:other-session-operation',
      request: {
        ...advancedOperationRecord().request,
        idempotencyKey: 'other-session-operation',
        sessionId: 'session-other',
      },
    });
    // A terminal record whose exact Discard recovery is still admitted: the
    // durable parent-deletion fact extinguishes that recovery authority, so
    // the deletion owner must clean and unlink it instead of preserving it.
    const terminal = ExternalSessionOperationRecordV1Schema.parse({
      ...terminalOperationRecord(),
      operationId: 'external-takeover:deleted-session-terminal',
      request: {
        ...terminalOperationRecord().request,
        idempotencyKey: 'deleted-session-terminal',
        sessionId: 'session-deleted',
      },
    });
    await writeExternalSessionOperationRecord(activeServerDir, deletedSessionRecord);
    await writeExternalSessionOperationRecord(activeServerDir, otherSessionRecord);
    await writeRawRecord(
      activeServerDir,
      terminal.operationId,
      JSON.stringify(terminal),
    );
    const cleanupPrivateOperation = vi.fn(async () => undefined);

    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted',
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 2, deferred: 0, retained: 0 });

    expect(cleanupPrivateOperation).toHaveBeenCalledTimes(2);
    expect(cleanupPrivateOperation).toHaveBeenCalledWith(deletedSessionRecord);
    expect(cleanupPrivateOperation).toHaveBeenCalledWith(terminal);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      deletedSessionRecord.operationId,
    )).resolves.toBeNull();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      otherSessionRecord.operationId,
    )).resolves.toEqual(otherSessionRecord);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      terminal.operationId,
    )).resolves.toBeNull();

    // Crash/retry and duplicate delivery are idempotent once the exact rows are gone.
    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted',
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 0, deferred: 0, retained: 0 });
    expect(cleanupPrivateOperation).toHaveBeenCalledTimes(2);
  });

  it('keeps the matching full record and retries when private cleanup fails before unlink', async () => {
    const activeServerDir = await createRoot();
    const record = ExternalSessionOperationRecordV1Schema.parse({
      ...terminalOperationRecord(),
      operationId: 'external-takeover:deleted-session-cleanup-failure',
      request: {
        ...terminalOperationRecord().request,
        idempotencyKey: 'deleted-session-cleanup-failure',
        sessionId: 'session-deleted-cleanup-failure',
      },
    });
    await writeRawRecord(activeServerDir, record.operationId, JSON.stringify(record));
    const cleanupPrivateOperation = vi.fn(async () => {
      throw new Error('external_session_operation_cleanup_failed');
    });

    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-cleanup-failure',
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).rejects.toThrow('external_session_operation_cleanup_failed');
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);

    // The durable deletion change retries after the failure is repaired.
    const repairedCleanup = vi.fn(async () => undefined);
    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-cleanup-failure',
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation: repairedCleanup,
    })).resolves.toEqual({ deleted: 1, deferred: 0, retained: 0 });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toBeNull();
  });

  it('retains compact terminal outcomes when their Session is deleted', async () => {
    const activeServerDir = await createRoot();
    const terminal = ExternalSessionOperationRecordV1Schema.parse({
      ...terminalOperationRecord(),
      operationId: 'external-takeover:deleted-session-receipt',
      terminalResult: { kind: 'discarded' },
      progressProjection: { acknowledgedRevision: 1 },
      request: {
        ...terminalOperationRecord().request,
        idempotencyKey: 'deleted-session-receipt',
        sessionId: 'session-deleted-receipt',
      },
    });
    await writeRawRecord(activeServerDir, terminal.operationId, JSON.stringify({ ...terminal, retiredField: true,
      request: { ...terminal.request, retiredField: true } }));
    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: terminal.operationId,
      expectedRevision: terminal.revision,
      stagingDisposition: 'missing',
    });
    if (compacted.status !== 'compacted' && compacted.status !== 'already_compacted') {
      throw new Error(
        `expected terminal receipt compaction to succeed, received ${compacted.status} (${('reason' in compacted) ? compacted.reason : 'n/a'})`,
      );
    }
    await writeRawRecord(activeServerDir, terminal.operationId, JSON.stringify({ ...compacted.receipt, retiredField: true,
      reference: { ...compacted.receipt.reference, retiredField: true },
      presentation: { ...compacted.receipt.presentation, retiredField: true } }));
    const cleanupPrivateOperation = vi.fn(async () => undefined);

    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-receipt',
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 0, deferred: 0, retained: 0 });
    expect(cleanupPrivateOperation).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      terminal.operationId,
    )).resolves.toMatchObject({ kind: 'terminal_receipt' });
  });

  it('finishes admitted effects in the captured A partition after an A→B account rotation', async () => {
    const activeServerDir = await createRoot();
    useAccount('account-rotation-a', 'a');
    const pinnedScope = resolveExternalSessionOperationAccountScope(
      activeServerDir,
      accountCredentials.current!.token,
    );
    if (!pinnedScope) throw new Error('expected pinned account scope');
    const record = ExternalSessionOperationRecordV1Schema.parse({
      ...advancedOperationRecord(),
      operationId: 'external-takeover:rotated-scope-operation',
      request: {
        ...advancedOperationRecord().request,
        idempotencyKey: 'rotated-scope-operation',
        sessionId: 'session-rotated-scope',
      },
    });
    await writeExternalSessionOperationRecord(activeServerDir, record, {
      accountScope: pinnedScope,
    });

    // Credentials rotate from Account A to Account B mid-operation.
    useAccount('account-rotation-b', 'b');
    accountCredentials.reads = 0;

    // Admitted work keeps its Account partition while the ambient Account
    // changes. Later requests without this pin resolve the new Account.
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      record,
      { accountScope: pinnedScope },
    )).resolves.toEqual(record);

    const accountBDirectory = join(
      activeServerDir,
      'external-session-operations',
      'by-account',
      `sub-${createHash('sha256').update('account-rotation-b', 'utf8').digest('hex').slice(0, 32)}`,
    );
    await expect(fsPromises.stat(accountBDirectory))
      .rejects.toMatchObject({ code: 'ENOENT' });

    // The admitted operation can still read its own retained record.
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      record.operationId,
      pinnedScope,
    )).resolves.toEqual({ kind: 'full_record', record });
    expect(accountCredentials.reads).toBe(0);
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      record.operationId,
    )).resolves.toBeNull();

    // Token refresh with the same subject keeps the pinned scope usable.
    useAccount('account-rotation-a', 'refreshed');
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
      pinnedScope,
    )).resolves.toEqual(record);
  });

  it('defers authoritative deletion while the exact operation claim remains active', async () => {
    const activeServerDir = await createRoot();
    const record = ExternalSessionOperationRecordV1Schema.parse({
      ...advancedOperationRecord(),
      operationId: 'external-takeover:active-deleted-session-operation',
      request: {
        ...advancedOperationRecord().request,
        idempotencyKey: 'active-deleted-session-operation',
        sessionId: 'session-deleted-active',
      },
    });
    await writeExternalSessionOperationRecord(activeServerDir, record);
    const cleanupPrivateOperation = vi.fn(async () => undefined);

    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-active',
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier: async () => ({ status: 'active' as const }),
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 0, deferred: 1, retained: 0 });
    expect(cleanupPrivateOperation).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);
  });

  it('defers authoritative deletion while a claimed operation has not written its first record', async () => {
    const activeServerDir = await createRoot();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'session-deletion-pre-record-claim-owner',
    });
    const acquired = await operationExclusion.acquire({
      kind: 'materialize',
      sessionId: 'session-deleted-before-first-record',
      requestId: 'request-before-first-record',
      sourceIdentity: 'source-before-first-record',
      sourceGeneration: 'generation-before-first-record',
    });
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') {
      throw new Error('Expected the pre-record operation claim.');
    }
    const cleanupPrivateOperation = vi.fn(async () => undefined);

    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-before-first-record',
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier:
        operationExclusion.withPassiveRepairSessionBarrier,
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 0, deferred: 1, retained: 0 });
    expect(cleanupPrivateOperation).not.toHaveBeenCalled();

    await acquired.claim.release();
  });

  it('replays cleanup idempotently when a crash occurs after private cleanup but before record unlink', async () => {
    const activeServerDir = await createRoot();
    const record = ExternalSessionOperationRecordV1Schema.parse({
      ...advancedOperationRecord(),
      operationId: 'external-takeover:deleted-session-cleanup-crash',
      request: {
        ...advancedOperationRecord().request,
        idempotencyKey: 'deleted-session-cleanup-crash',
        sessionId: 'session-deleted-cleanup-crash',
      },
    });
    await writeExternalSessionOperationRecord(activeServerDir, record);
    let crashAfterCleanup = true;
    const cleanupPrivateOperation = vi.fn(async () => {
      if (crashAfterCleanup) {
        crashAfterCleanup = false;
        throw new Error('simulated_crash_after_private_cleanup');
      }
    });
    const withSessionOperationBarrier = async <T>(
      _input: Readonly<{ sessionId: string }>,
      effect: () => Promise<T>,
    ) => ({ status: 'executed' as const, value: await effect() });

    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: record.request.sessionId,
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier,
      cleanupPrivateOperation,
    })).rejects.toThrow('simulated_crash_after_private_cleanup');
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);

    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: record.request.sessionId,
      accountScope: vitestAmbientAccountScope(activeServerDir),
      withSessionOperationBarrier,
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 1, deferred: 0, retained: 0 });
    expect(cleanupPrivateOperation).toHaveBeenCalledTimes(2);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toBeNull();
  });

  it('cleans the owning Account partition for an authoritative deletion after an A→B ambient rotation', async () => {
    const activeServerDir = await createRoot();
    useAccount('account-deletion-a');
    const owningScope = resolveExternalSessionOperationAccountScope(
      activeServerDir,
      accountCredentials.current!.token,
    );
    if (!owningScope) throw new Error('expected Account A operation scope');
    const runningRecord = ExternalSessionOperationRecordV1Schema.parse({
      ...advancedOperationRecord(),
      operationId: 'external-takeover:rotation-deleted-running',
      request: {
        ...advancedOperationRecord().request,
        idempotencyKey: 'rotation-deleted-running',
        sessionId: 'session-deleted-rotation',
      },
    });
    const terminalRecord = ExternalSessionOperationRecordV1Schema.parse({
      ...terminalOperationRecord(),
      operationId: 'external-takeover:rotation-deleted-terminal',
      request: {
        ...terminalOperationRecord().request,
        idempotencyKey: 'rotation-deleted-terminal',
        sessionId: 'session-deleted-rotation',
      },
    });
    const otherSessionRecord = ExternalSessionOperationRecordV1Schema.parse({
      ...advancedOperationRecord(),
      operationId: 'external-takeover:rotation-other-session',
      request: {
        ...advancedOperationRecord().request,
        idempotencyKey: 'rotation-other-session',
        sessionId: 'session-rotation-other',
      },
    });
    // Seed the terminal row first; the normal admission owner permits a later
    // nonterminal row when the existing same-session row is already terminal.
    await writeExternalSessionOperationRecord(activeServerDir, terminalRecord, {
      accountScope: owningScope,
    });
    await writeExternalSessionOperationRecord(activeServerDir, runningRecord, {
      accountScope: owningScope,
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      otherSessionRecord,
      { accountScope: owningScope },
    );
    // The ambient Account rotates to B before the durable deletion fact is
    // consumed.
    useAccount('account-deletion-b');
    const ambientBScope = resolveExternalSessionOperationAccountScope(
      activeServerDir,
      accountCredentials.current!.token,
    );
    if (!ambientBScope) throw new Error('expected Account B operation scope');
    const cleanupPrivateOperation = vi.fn(async () => undefined);

    // Account B can never see or clean Account A's rows through B's own
    // partition.
    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-rotation',
      accountScope: ambientBScope,
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 0, deferred: 0, retained: 0 });
    expect(cleanupPrivateOperation).not.toHaveBeenCalled();

    // The deletion fact pins the Account whose authoritative changes feed
    // delivered it, so cleanup retires exactly Account A's partition — the
    // ambient B credentials are never consulted.
    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-rotation',
      accountScope: owningScope,
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 2, deferred: 0, retained: 0 });
    // Private staging/media cleanup runs for every matching full record, and
    // already-compacted terminal receipts carry no private recovery state, so
    // they are never cleanup candidates.
    expect(cleanupPrivateOperation).toHaveBeenCalledTimes(2);
    expect(cleanupPrivateOperation).toHaveBeenCalledWith(runningRecord);
    expect(cleanupPrivateOperation).toHaveBeenCalledWith(terminalRecord);

    // Retry and duplicate delivery stay idempotent once the rows are gone.
    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-rotation',
      accountScope: owningScope,
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).resolves.toEqual({ deleted: 0, deferred: 0, retained: 0 });
    expect(cleanupPrivateOperation).toHaveBeenCalledTimes(2);

    // The retired ambient-resolution path fails closed: without the fact's
    // pinned scope, exact ownership cannot be established.
    // @ts-expect-error — accountScope is required; ambient resolution is
    // the retired split-brain this assertion proves closed.
    await expect(abandonExternalSessionOperationsForDeletedSession({
      activeServerDir,
      sessionId: 'session-deleted-rotation',
      withSessionOperationBarrier: async (_input, effect) => ({
        status: 'executed' as const,
        value: await effect(),
      }),
      cleanupPrivateOperation,
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'account_scope_unavailable',
    });

    // Verify Account A's partition through the read owner after A
    // re-authenticates.
    useAccount('account-deletion-a', 'refreshed');
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      runningRecord.operationId,
      owningScope,
    )).resolves.toBeNull();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      terminalRecord.operationId,
      owningScope,
    )).resolves.toBeNull();
    // The unacknowledged terminal full record is deleted with the Session;
    // compacted receipts (when present) retain their exact replay outcome.
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      terminalRecord.operationId,
      owningScope,
    )).resolves.toBeNull();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      otherSessionRecord.operationId,
      owningScope,
    )).resolves.toEqual(otherSessionRecord);
  });

  it('treats an absent operation-storage root as an empty inventory before Account scope is available', async () => {
    const activeServerDir = await createRoot();
    const priorVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(listExternalSessionOperationRecords(activeServerDir))
        .resolves.toEqual([]);
    } finally {
      if (priorVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = priorVitest;
      }
    }
  });

  it('keeps an existing operation-storage root closed when Account scope is unavailable', async () => {
    const activeServerDir = await createRoot();
    await fsPromises.mkdir(join(
      activeServerDir,
      'external-session-operations',
    ));
    const priorVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(listExternalSessionOperationRecords(activeServerDir))
        .rejects.toMatchObject({
          name: 'ExternalSessionOperationRecordReadError',
          reason: 'account_scope_unavailable',
        });
    } finally {
      if (priorVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = priorVitest;
      }
    }
  });

  it('scopes receipt and conflict admission to the current Account subject, including a refreshed token', async () => {
    const activeServerDir = await createRoot();
    const completed = ExternalSessionOperationRecordV1Schema.parse({
      ...completedExternalLinkedOperationRecord(),
      authorIntent: pluginTakeoverAuthorIntent('remote-1', 'external-linked'),
      progressProjection: { acknowledgedRevision: null },
    });
    if (!completed.authorIntent) {
      throw new Error('Expected plugin author intent fixture.');
    }
    useAccount('account-a', 'before-refresh');
    await writeExternalSessionOperationRecord(activeServerDir, completed);
    await acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: completed.operationId,
      projectedRevision: completed.revision,
    });
    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: completed.operationId,
      expectedRevision: completed.revision,
      stagingDisposition: 'not_applicable',
    });
    if (compacted.status === 'not_eligible') {
      throw new Error(`Expected receipt fixture, got ${compacted.reason}`);
    }

    await expect(resolveExternalSessionPluginOperationPreflightAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      authorIntent: completed.authorIntent,
    })).resolves.toMatchObject({
      kind: 'terminal_receipt',
      receipt: { reference: { operationId: completed.operationId } },
    });

    // Refreshing the token must not change the durable Account namespace.
    useAccount('account-a', 'after-refresh');
    await expect(resolveExternalSessionPluginOperationPreflightAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      authorIntent: completed.authorIntent,
    })).resolves.toMatchObject({ kind: 'terminal_receipt' });

    // A second Account sharing this server may reuse the opaque key without
    // learning the first Account's receipt or conflict outcome.
    useAccount('account-b');
    await expect(resolveExternalSessionPluginOperationPreflightAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      authorIntent: completed.authorIntent,
    })).resolves.toEqual({ kind: 'miss' });
    await expect(resolveExternalSessionPluginOperationPreflightAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      authorIntent: pluginTakeoverAuthorIntent('remote-other', 'external-linked'),
    })).resolves.toEqual({ kind: 'miss' });
  });

  it('does not let one Account consume another Account capacity on the same server', async () => {
    const activeServerDir = await createRoot();
    const syntheticInventory = new Map<string, string>();
    for (let index = 0; index < 10_000; index += 1) {
      const operationId = `external-takeover:account-a-capacity-${index}`;
      const capacityRequest = {
        ...request,
        idempotencyKey: `account-a-capacity-key-${index}`,
        sessionId: `account-a-capacity-session-${index}`,
      } satisfies ExternalSessionOperationSemanticRequestV1;
      const record = ExternalSessionOperationRecordV1Schema.parse({
        ...operationRecord(),
        operationId,
        request: capacityRequest,
        timeline: resolveExternalSessionOperationTimelineV1(capacityRequest),
      });
      const filename = `${createHash('sha256').update(operationId, 'utf8').digest('hex')}.json`;
      syntheticInventory.set(filename, JSON.stringify(record));
    }
    readFileBoundary.syntheticInventory = syntheticInventory;
    readFileBoundary.syntheticInventoryDirectories = [
      '/external-session-operations/records',
      accountRecordDirectorySuffix('account-a'),
    ];

    useAccount('account-b');
    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: 'account-b-capacity-key',
      intent: {
        ...request,
        idempotencyKey: 'account-b-capacity-key',
      },
    })).resolves.toMatchObject({ kind: 'new_operation' });
  });

  it('quarantines a matching legacy server-scoped row rather than replaying or conflicting it', async () => {
    const activeServerDir = await createRoot();
    const legacy = pluginMaterializeRecord({
      operationId: 'external-materialize:legacy-unscoped',
      sessionId: 'session-legacy',
      durableIdempotencyKey: 'legacy-unscoped-key',
    });
    await writeRawLegacyRecord(
      activeServerDir,
      legacy.operationId,
      JSON.stringify(legacy),
    );
    useAccount('account-a');

    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: legacy.request.idempotencyKey,
      intent: legacy.request,
      authorIntent: legacy.authorIntent,
    })).resolves.toEqual({ kind: 'legacy_unavailable' });
  });

  it('still quarantines a matching legacy row when an unrelated legacy row is malformed', async () => {
    const activeServerDir = await createRoot();
    const legacy = pluginMaterializeRecord({
      operationId: 'external-materialize:legacy-unscoped-with-noise',
      sessionId: 'session-legacy',
      durableIdempotencyKey: 'legacy-unscoped-noise-key',
    });
    await writeRawLegacyRecord(
      activeServerDir,
      legacy.operationId,
      JSON.stringify(legacy),
    );
    await writeRawLegacyRecord(
      activeServerDir,
      'external-materialize:legacy-unrelated-malformed',
      '{"v":1,"not":"an operation record"}',
    );

    useAccount('account-a');

    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: legacy.request.idempotencyKey,
      intent: legacy.request,
      authorIntent: legacy.authorIntent,
    })).resolves.toEqual({ kind: 'legacy_unavailable' });
  });

  it.each(['completed', 'cancelled', 'discarded'] as const)(
    'compacts an acknowledged settled %s operation after its terminal work is clean',
    async (status) => {
      const activeServerDir = await createRoot();
      const terminal = ExternalSessionOperationRecordV1Schema.parse({
        ...completedExternalLinkedOperationRecord(),
        operationId: `external-takeover:${status}-retention-fixture`,
        status,
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
      await writeRawRecord(
        activeServerDir,
        terminal.operationId,
        JSON.stringify(terminal),
      );

      const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
        activeServerDir,
        operationId: terminal.operationId,
        expectedRevision: terminal.revision,
        stagingDisposition: 'not_applicable',
      });

      expect(compacted).toEqual(expect.objectContaining({
        status: 'compacted',
        receipt: expect.objectContaining({
          recordKind: 'terminal_receipt',
          presentation: expect.objectContaining({ status }),
          terminalAtMs: terminal.updatedAtMs,
        }),
      }));
      if (compacted.status !== 'compacted') {
        throw new Error(`Expected ${status} operation to compact.`);
      }
      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        terminal.operationId,
      )).resolves.toEqual({
        kind: 'terminal_receipt',
        receipt: compacted.receipt,
      });
    },
  );

  it('atomically compacts an acknowledged completed operation to the strict minimal terminal receipt', async () => {
    const activeServerDir = await createRoot();
    const completed = completedExternalLinkedOperationRecord();
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      JSON.stringify(completed),
    );

    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: completed.operationId,
      expectedRevision: completed.revision,
      stagingDisposition: 'not_applicable',
    });

    expect(compacted).toMatchObject({
      status: 'compacted',
      receipt: {
        v: 1,
        recordKind: 'terminal_receipt',
        reference: {
          sessionId: completed.request.sessionId,
          operationId: completed.operationId,
          revision: completed.revision,
        },
        presentation: {
          v: 1,
          operationId: completed.operationId,
          revision: completed.revision,
          kind: 'takeover_external_linked',
          status: 'completed',
          phase: 'finalizing',
        },
        durableIdempotencyKey: completed.request.idempotencyKey,
        terminalAtMs: completed.updatedAtMs,
      },
    });
    if (compacted.status === 'not_eligible') {
      throw new Error('Expected completed operation to compact.');
    }
    expect(compacted.receipt.idempotencyIntentDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      completed.operationId,
    )).resolves.toBeNull();
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toEqual({
      kind: 'terminal_receipt',
      receipt: compacted.receipt,
    });

    const persisted = JSON.parse(await fsPromises.readFile(
      pathForRecord(activeServerDir, completed.operationId),
      'utf8',
    )) as Record<string, unknown>;
    for (const forbidden of [
      'request',
      'checkpoint',
      'fence',
      'bindings',
      'canonicalOwnerEvidence',
      'publication',
      'progressProjection',
      'terminalResult',
      'expiresAtMs',
    ]) {
      expect(persisted).not.toHaveProperty(forbidden);
    }

    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      completed,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordTransitionError',
      reason: 'compacted_record',
    });
    await expect(acknowledgeExternalSessionOperationProgressProjection({
      activeServerDir,
      operationId: completed.operationId,
      projectedRevision: completed.revision,
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationProgressProjectionAcknowledgementError',
      reason: 'operation_not_found',
    });
    await expect(mutateExternalSessionOperationRecordAtRevision(
      activeServerDir,
      completed.operationId,
      completed.revision,
      (current) => current,
    )).resolves.toEqual({
      ok: false,
      code: 'operation_not_found',
    });
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toEqual({
      kind: 'terminal_receipt',
      receipt: compacted.receipt,
    });

  });

  it('rejects the never-deployed completed-only receipt spelling instead of treating it as terminal evidence', async () => {
    const activeServerDir = await createRoot();
    const completed = completedExternalLinkedOperationRecord();
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      JSON.stringify(completed),
    );
    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: completed.operationId,
      expectedRevision: completed.revision,
      stagingDisposition: 'not_applicable',
    });
    if (compacted.status === 'not_eligible') {
      throw new Error('Expected completed operation to compact.');
    }
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      JSON.stringify({
        ...compacted.receipt,
        recordKind: 'completed_receipt',
      }),
    );

    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'invalid_record',
    });
  });

  it.each(['running', 'failed', 'reconciliation_required'] as const)(
    'fails closed on a %s row mislabeled as a terminal receipt',
    async (status) => {
      const activeServerDir = await createRoot();
      const completed = completedExternalLinkedOperationRecord();
      await writeRawRecord(
        activeServerDir,
        completed.operationId,
        JSON.stringify(completed),
      );
      const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
        activeServerDir,
        operationId: completed.operationId,
        expectedRevision: completed.revision,
        stagingDisposition: 'not_applicable',
      });
      if (compacted.status === 'not_eligible') {
        throw new Error('Expected completed operation to compact.');
      }
      await writeRawRecord(
        activeServerDir,
        completed.operationId,
        JSON.stringify({
          ...compacted.receipt,
          presentation: {
            ...compacted.receipt.presentation,
            status,
          },
        }),
      );

      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        completed.operationId,
      )).rejects.toMatchObject({
        name: 'ExternalSessionOperationRecordReadError',
        reason: 'invalid_record',
      });
    },
  );

  it('retains exact private plugin author intent in terminal receipts', async () => {
    const activeServerDir = await createRoot();
    const nativeCompleted = completedExternalLinkedOperationRecord();
    const authorIntent = pluginTakeoverAuthorIntent(
      nativeCompleted.request.source.remoteSessionId,
      'external-linked',
    );
    const completed = ExternalSessionOperationRecordV1Schema.parse({
      ...nativeCompleted,
      authorIntent,
    });
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      JSON.stringify(completed),
    );

    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: completed.operationId,
      expectedRevision: completed.revision,
      stagingDisposition: 'not_applicable',
    });
    if (compacted.status === 'not_eligible') {
      throw new Error('Expected plugin-authored operation to compact.');
    }
    expect(compacted.receipt.authorIntent).toEqual(authorIntent);
    expect(compacted.receipt).not.toHaveProperty('idempotencyIntentDigest');
    const { idempotencyIntentDigest: _redundantDigest, ...authorOnlyReceipt } = compacted.receipt;
    await writeRawRecord(activeServerDir, completed.operationId, JSON.stringify(authorOnlyReceipt));

    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      intent: completed.request,
      authorIntent,
    })).resolves.toEqual({
      kind: 'terminal_receipt',
      receipt: authorOnlyReceipt,
    });
    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      intent: completed.request,
      authorIntent: {
        ...authorIntent,
        sourceId: 'codexHome:other',
      },
    })).resolves.toEqual({ kind: 'conflict' });
  });

  it('rejects every nonterminal or recovery-bearing compaction state and preserves its full-record bytes', async () => {
    const activeServerDir = await createRoot();
    const completed = completedExternalLinkedOperationRecord();
    const acknowledgedRecoveryRecord = (
      record: ExternalSessionOperationRecordV1,
    ): ExternalSessionOperationRecordV1 =>
      ExternalSessionOperationRecordV1Schema.parse({
        ...record,
        progressProjection: { acknowledgedRevision: record.revision },
      });
    const failedRecord = (
      retryable: boolean,
    ): ExternalSessionOperationRecordV1 => acknowledgedRecoveryRecord({
      ...operationRecord(),
      operationId: retryable
        ? 'external-takeover:compaction-retryable-failure-fixture'
        : 'external-takeover:compaction-failed-fixture',
      revision: 1,
      status: 'failed',
      updatedAtMs: 2,
      error: {
        code: retryable ? 'source_unavailable' : 'internal_error',
        message: retryable
          ? 'The captured source may be retried.'
          : 'The operation failed permanently.',
        retryable,
        occurredAtMs: 2,
      },
    });
    const unacknowledged = ExternalSessionOperationRecordV1Schema.parse({
      ...completed,
      operationId: `${completed.operationId}-unacknowledged`,
      progressProjection: { acknowledgedRevision: null },
    });
    const completedMaterializeRecord = (
      suffix: string,
    ): ExternalSessionOperationRecordV1 => {
      if (completed.request.plan !== 'takeover') {
        throw new Error('expected completed takeover fixture');
      }
      const {
        targetDirectory: _targetDirectory,
        ...materializeRequestBase
      } = completed.request;
      const materializeRequest = {
        ...materializeRequestBase,
        idempotencyKey: `compaction-staging-${suffix}`,
        plan: 'materialize' as const,
        targetStorageMode: 'external-linked' as const,
        targetRuntimeMode: null,
      };
      return ExternalSessionOperationRecordV1Schema.parse({
        ...completed,
        operationId: `external-materialize:compaction-staging-${suffix}`,
        request: materializeRequest,
        phase: 'publishing',
        timeline: resolveExternalSessionOperationTimelineV1(materializeRequest),
        currentStorageState: 'snapshot_complete',
        checkpoint: {
          ...completed.checkpoint,
          acceptedThroughServerSeq: 0,
          acknowledgedBatchId: `compaction-staging-${suffix}`,
        },
        bindings: {
          ...completed.bindings,
          privateStagingId: `private-staging-${suffix}`,
        },
        publication: {
          materializationPublicationId: `publication-${suffix}`,
          materializedThroughSourceAt: completed.updatedAtMs,
          publishedThroughServerSeq: 0,
        },
      });
    };
    const cancelledInitialPartial = cancelledInitialPartialMaterializeRecord();
    const cancelledLocalPrivateCapture =
      cancelledLocalPrivateCaptureMaterializeRecord();
    const cases = [
      {
        name: 'nonterminal',
        record: acknowledgedRecoveryRecord({
          ...operationRecord(),
          operationId: 'external-takeover:compaction-nonterminal-fixture',
        }),
        stagingDisposition: 'not_applicable',
        reason: 'operation_not_terminal',
      },
      {
        name: 'failed',
        record: failedRecord(false),
        stagingDisposition: 'not_applicable',
        reason: 'operation_not_terminal',
      },
      {
        name: 'retryable failure',
        record: failedRecord(true),
        stagingDisposition: 'not_applicable',
        reason: 'operation_not_terminal',
      },
      {
        name: 'unacknowledged completion',
        record: unacknowledged,
        stagingDisposition: 'not_applicable',
        reason: 'projection_unacknowledged',
      },
      {
        name: 'cancelled initial partial awaiting server discard',
        record: cancelledInitialPartial,
        stagingDisposition: 'cleaned',
        reason: 'recovery_action_required',
      },
      {
        name: 'cancelled local private capture awaiting explicit discard',
        record: cancelledLocalPrivateCapture,
        stagingDisposition: 'cleaned',
        reason: 'recovery_action_required',
      },
      ...(['not_applicable', 'not_ready', 'not_terminal'] as const).map(
        (stagingDisposition) => ({
          name: `staging ${stagingDisposition}`,
          record: completedMaterializeRecord(stagingDisposition),
          stagingDisposition,
          reason: 'staging_not_clean' as const,
        }),
      ),
    ] satisfies readonly Readonly<{
      name: string;
      record: ExternalSessionOperationRecordV1;
      stagingDisposition:
        | 'not_applicable'
        | 'cleaned'
        | 'missing'
        | 'not_ready'
        | 'not_terminal';
      reason:
        | 'operation_not_terminal'
        | 'recovery_action_required'
        | 'projection_unacknowledged'
        | 'staging_not_clean';
    }>[];

    for (const testCase of cases) {
      const originalBytes = `${JSON.stringify(testCase.record, null, 2)}\n`;
      const path = await writeRawRecord(
        activeServerDir,
        testCase.record.operationId,
        originalBytes,
      );

      const result = await compactExternalSessionOperationRecordToTerminalReceipt({
        activeServerDir,
        operationId: testCase.record.operationId,
        expectedRevision: testCase.record.revision,
        stagingDisposition: testCase.stagingDisposition,
      });

      expect({ name: testCase.name, result }).toEqual({
        name: testCase.name,
        result: {
          status: 'not_eligible',
          reason: testCase.reason,
        },
      });
      await expect(fsPromises.readFile(path, 'utf8')).resolves.toBe(
        originalBytes,
      );
      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        testCase.record.operationId,
      )).resolves.toEqual({
        kind: 'full_record',
        record: testCase.record,
      });
    }
  });

  it('retains takeover terminal preferences across durable record reloads', async () => {
    const activeServerDir = await createRoot();
    const terminal = { mode: 'tmux' as const, tmux: { sessionName: 'takeover', isolated: true, tmpDir: '/tmp/takeover-tmux' } };
    const record = { ...operationRecord(), request: { ...request, terminal } };
    await writeExternalSessionOperationRecord(activeServerDir, record);
    await expect(readExternalSessionOperationRecord(activeServerDir, record.operationId)).resolves.toEqual(record);
  });

  it('replays the exact terminal outcome after the former receipt expiry', async () => {
    const activeServerDir = await createRoot();
    const completed = completedExternalLinkedOperationRecord();
    if (completed.request.plan !== 'takeover') {
      throw new Error('Expected takeover fixture.');
    }
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      JSON.stringify(completed),
    );

    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      intent: completed.request,
    })).resolves.toEqual({
      kind: 'existing_record',
      record: completed,
    });

    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: completed.operationId,
      expectedRevision: completed.revision,
      stagingDisposition: 'not_applicable',
    });
    if (compacted.status === 'not_eligible') {
      throw new Error('Expected completed operation to compact.');
    }
    // Historical receipts carried an expiry. It is no longer execution authority.
    await writeRawRecord(activeServerDir, completed.operationId, JSON.stringify({
      ...compacted.receipt,
      expiresAtMs: completed.updatedAtMs + 86_400_000,
    }));
    const {
      sourceGeneration: _sourceGeneration,
      sourceCustody: _sourceCustody,
      ...publicSource
    } = completed.request.source;
    const publicRetryIntent = {
      ...completed.request,
      source: publicSource,
    };

    vi.spyOn(Date, 'now').mockReturnValue(completed.updatedAtMs + 86_400_000);
    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      intent: publicRetryIntent,
    })).resolves.toEqual({
      kind: 'terminal_receipt',
      receipt: compacted.receipt,
    });
    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      intent: {
        ...publicRetryIntent,
        terminal: { mode: 'tmux', tmux: { sessionName: 'takeover', isolated: true, tmpDir: null } },
      },
    })).resolves.toEqual({ kind: 'conflict' });
    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      intent: {
        ...publicRetryIntent,
        plan: 'takeover' as const,
        targetStorageMode: 'persisted' as const,
      },
    })).resolves.toEqual({ kind: 'conflict' });

    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: completed.request.idempotencyKey,
      intent: publicRetryIntent,
    })).resolves.toEqual({ kind: 'terminal_receipt', receipt: compacted.receipt });
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toEqual({ kind: 'terminal_receipt', receipt: compacted.receipt });
  });

  it('fails closed on malformed or future receipt rows instead of treating them as absent or expired', async () => {
    const activeServerDir = await createRoot();
    const completed = completedExternalLinkedOperationRecord();
    const poisonedReceipt = {
      v: 2,
      recordKind: 'terminal_receipt',
      reference: {
        sessionId: completed.request.sessionId,
        operationId: completed.operationId,
        revision: completed.revision,
      },
      presentation: {
        v: 1,
        operationId: completed.operationId,
        revision: completed.revision,
        kind: 'takeover_external_linked',
        status: 'completed',
        phase: 'finalizing',
      },
      durableIdempotencyKey: completed.request.idempotencyKey,
      idempotencyIntentDigest: 'a'.repeat(64),
      terminalAtMs: completed.updatedAtMs,
      expiresAtMs: completed.updatedAtMs + 86_400_000,
      bindings: { operationClaimId: 'must-not-survive-compaction' },
    };
    const contents = JSON.stringify(poisonedReceipt);
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      contents,
    );

    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'invalid_record',
    });
    await expect(assertExternalSessionOperationRecordAdmission(
      activeServerDir,
      {
        sessionId: 'other-session',
        operationId: 'external-takeover:new-operation',
        idempotencyKey: 'new-key',
      },
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'inventory_unreadable',
    });
    await expect(fsPromises.readFile(
      pathForRecord(activeServerDir, completed.operationId),
      'utf8',
    )).resolves.toBe(contents);

    const {
      bindings: _silentlyNormalizableBindings,
      ...receiptWithoutBindings
    } = poisonedReceipt;
    const silentlyNormalizableReceipt = {
      ...receiptWithoutBindings,
      v: 1,
      durableIdempotencyKey: ` ${completed.request.idempotencyKey}`,
    };
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      JSON.stringify(silentlyNormalizableReceipt),
    );
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'invalid_record',
    });

    const silentlyNormalizableIdentityReceipt = {
      ...receiptWithoutBindings,
      v: 1,
      reference: {
        ...poisonedReceipt.reference,
        sessionId: ` ${poisonedReceipt.reference.sessionId}`,
      },
    };
    await writeRawRecord(
      activeServerDir,
      completed.operationId,
      JSON.stringify(silentlyNormalizableIdentityReceipt),
    );
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'invalid_record',
    });
  });


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

  it('rejects a record missing the projection receipt instead of reconciling it', async () => {
    const activeServerDir = await createRoot();
    const record = operationRecord();
    const {
      progressProjection: _progressProjection,
      ...recordWithoutProjection
    } = record;
    await writeRawRecord(
      activeServerDir,
      record.operationId,
      JSON.stringify(recordWithoutProjection),
    );

    // `progressProjection` is a required field of the one canonical record
    // shape. Nothing has ever written a row without it outside a development
    // worktree, so the reader must not invent an acknowledgement revision.
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordReadError',
      reason: 'invalid_record',
    });
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

  it('atomically converges concurrent same-intent rows at the inventory owner', async () => {
    const activeServerDir = await createRoot();
    const left = {
      ...operationRecord(),
      operationId: 'external-takeover:concurrent-left',
    } satisfies ExternalSessionOperationRecordV1;
    const rightRequest = {
      ...request,
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const right = {
      ...operationRecord(),
      operationId: 'external-takeover:concurrent-right',
      request: rightRequest,
      timeline: resolveExternalSessionOperationTimelineV1(rightRequest),
    } satisfies ExternalSessionOperationRecordV1;

    const [leftResult, rightResult] = await Promise.all([
      writeExternalSessionOperationRecord(activeServerDir, left),
      writeExternalSessionOperationRecord(activeServerDir, right),
    ]);

    expect(rightResult.operationId).toBe(leftResult.operationId);
    await expect(listExternalSessionOperationRecords(activeServerDir))
      .resolves.toEqual([leftResult]);

    const changedRequest = {
      ...rightRequest,
      sessionId: 'session-concurrent-changed',
      source: {
        ...rightRequest.source,
        remoteSessionId: 'remote-changed',
      },
    } satisfies ExternalSessionOperationSemanticRequestV1;
    await expect(writeExternalSessionOperationRecord(activeServerDir, {
      ...right,
      operationId: 'external-takeover:concurrent-changed',
      request: changedRequest,
      timeline: resolveExternalSessionOperationTimelineV1(changedRequest),
    })).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
  });

  it('atomically converges same-intent cross-Session author admission and conflicts a changed-intent race', async () => {
    const activeServerDir = await createRoot();
    const durableIdempotencyKey = 'plugin-principal-a:concurrent-intent';
    const authorIntent = pluginTakeoverAuthorIntent();
    const initialContenders = [
      pluginTakeoverRecord({
        operationId: 'external-takeover:plugin-contender-a',
        sessionId: 'session-a',
        durableIdempotencyKey,
        authorIntent,
      }),
      pluginTakeoverRecord({
        operationId: 'external-takeover:plugin-contender-b',
        sessionId: 'session-b',
        durableIdempotencyKey,
        authorIntent,
      }),
    ];

    const [left, right] = await Promise.all(initialContenders.map(
      async (record) => await writeExternalSessionOperationRecord(
        activeServerDir,
        record,
      ),
    ));
    expect(right.operationId).toBe(left.operationId);
    expect(right.request.sessionId).toBe(left.request.sessionId);

    const retryRace = [
      pluginTakeoverRecord({
        operationId: 'external-takeover:plugin-retry-c',
        sessionId: 'session-c',
        durableIdempotencyKey,
        authorIntent,
      }),
      pluginTakeoverRecord({
        operationId: 'external-takeover:plugin-retry-d',
        sessionId: 'session-d',
        durableIdempotencyKey,
        authorIntent: pluginTakeoverAuthorIntent(
          'remote-2',
          'external-linked',
        ),
      }),
    ];

    const settled = await Promise.allSettled(retryRace.map(
      async (record) => await writeExternalSessionOperationRecord(
        activeServerDir,
        record,
      ),
    ));
    const fulfilled = settled.find((result) => result.status === 'fulfilled');
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(fulfilled).toMatchObject({
      status: 'fulfilled',
      value: {
        operationId: left.operationId,
        request: { sessionId: left.request.sessionId },
      },
    });
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        name: 'ExternalSessionOperationRecordAdmissionError',
        reason: 'conflicting_operation',
      },
    });

    const retained = (await listExternalSessionOperationRecords(activeServerDir))
      .filter((record) => record.request.idempotencyKey === durableIdempotencyKey);
    expect(retained).toHaveLength(1);
  });

  it('conflicts changed materialize author intent without disturbing exact replay', async () => {
    const activeServerDir = await createRoot();
    const durableIdempotencyKey = 'plugin-principal-a:materialize';
    const existing = pluginMaterializeRecord({
      operationId: 'external-materialize:plugin-existing',
      sessionId: 'session-materialize-a',
      durableIdempotencyKey,
    });
    await writeExternalSessionOperationRecord(activeServerDir, existing);
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      existing,
    )).resolves.toEqual(existing);

    const changedIntent = pluginMaterializeRecord({
      operationId: 'external-materialize:plugin-changed-intent',
      sessionId: 'session-materialize-b',
      durableIdempotencyKey,
    });
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      changedIntent,
    )).rejects.toMatchObject({
      name: 'ExternalSessionOperationRecordAdmissionError',
      reason: 'conflicting_operation',
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      existing.operationId,
    )).resolves.toEqual(existing);
  });

  it('keeps plugin and native callers in distinct durable-key namespaces', async () => {
    const activeServerDir = await createRoot();
    const sharedStoredKey = 'plugin-operation:v1:shared-stored-key';
    const nativeRequest = {
      ...request,
      idempotencyKey: sharedStoredKey,
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const native = {
      ...terminalOperationRecord(),
      operationId: 'external-takeover:native-namespace',
      request: nativeRequest,
      timeline: resolveExternalSessionOperationTimelineV1(nativeRequest),
    } satisfies ExternalSessionOperationRecordV1;
    const plugin = pluginTakeoverRecord({
      operationId: 'external-takeover:plugin-namespace',
      sessionId: 'session-plugin-namespace',
      durableIdempotencyKey: sharedStoredKey,
      authorIntent: pluginTakeoverAuthorIntent(),
    });

    await writeExternalSessionOperationRecord(activeServerDir, native);
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      plugin,
    )).resolves.toEqual(plugin);
    await expect(listExternalSessionOperationRecords(activeServerDir))
      .resolves.toEqual(expect.arrayContaining([native, plugin]));

    const nativeCompleted = ExternalSessionOperationRecordV1Schema.parse({
      ...completedExternalLinkedOperationRecord(),
      operationId: 'external-takeover:native-receipt-namespace',
      request: {
        ...completedExternalLinkedOperationRecord().request,
        idempotencyKey: 'plugin-operation:v1:shared-receipt-key',
      },
    });
    await writeRawRecord(
      activeServerDir,
      nativeCompleted.operationId,
      JSON.stringify(nativeCompleted),
    );
    const compacted = await compactExternalSessionOperationRecordToTerminalReceipt({
      activeServerDir,
      operationId: nativeCompleted.operationId,
      expectedRevision: nativeCompleted.revision,
      stagingDisposition: 'not_applicable',
    });
    if (compacted.status === 'not_eligible') {
      throw new Error('Expected native operation to compact.');
    }
    const pluginIntent = pluginTakeoverRecord({
      operationId: 'external-takeover:plugin-receipt-namespace',
      sessionId: 'session-plugin-receipt-namespace',
      durableIdempotencyKey: nativeCompleted.request.idempotencyKey,
      authorIntent: pluginTakeoverAuthorIntent('remote-plugin-receipt'),
    });
    await expect(resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: pluginIntent.request.idempotencyKey,
      intent: pluginIntent.request,
      authorIntent: pluginIntent.authorIntent,
    })).resolves.toMatchObject({ kind: 'new_operation' });
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
      operationId: 'external-takeover:session-admission-next',
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
      operationId: 'external-takeover:terminal-successor',
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
    const validateSessionAdmission = vi.fn(async (
      current: ExternalSessionOperationRecordV1 | null,
      incoming: ExternalSessionOperationRecordV1,
      priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
    ) => {
      expect(current).toBeNull();
      expect(incoming).toEqual(successor);
      expect(priorTerminalRecords).toEqual([{
        ...prior,
        progressProjection: {
          acknowledgedRevision: prior.revision,
        },
      }]);
      return undefined;
    });

    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      successor,
      {
        settlePriorTerminalProgressProjection,
        validateSessionAdmission,
      },
    )).resolves.toEqual(successor);
    expect(settlePriorTerminalProgressProjection).toHaveBeenCalledOnce();
    expect(validateSessionAdmission).toHaveBeenCalledOnce();
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
      operationId: 'external-takeover:hidden-nonterminal-next',
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
    const { targetDirectory: _targetDirectory, ...materializeRequest } = request;
    const changedPlanRequest = {
      ...materializeRequest,
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    } satisfies ExternalSessionOperationSemanticRequestV1;
    const changedPlan = {
      ...takeover,
      operationId: 'external-materialize:changed-plan-reuse',
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

  it('loads the lock-held admission inventory with overlapping bounded reads in directory order', async () => {
    const activeServerDir = await createRoot();
    const base = terminalOperationRecord();
    const syntheticInventory = new Map<string, string>();
    const expectedOperationIds: string[] = [];
    for (let index = 0; index < 128; index += 1) {
      const operationId =
        `external-takeover:concurrency-${String(index).padStart(5, '0')}`;
      expectedOperationIds.push(operationId);
      syntheticInventory.set(
        basename(pathForRecord(activeServerDir, operationId)),
        JSON.stringify({
          ...base,
          operationId,
          request: {
            ...base.request,
            sessionId: `concurrency-session-${index}`,
            idempotencyKey: `concurrency-key-${index}`,
          },
        } satisfies ExternalSessionOperationRecordV1),
      );
    }
    readFileBoundary.syntheticInventory = syntheticInventory;
    readFileBoundary.observeRecordReads = true;
    readFileBoundary.observeReadConcurrency = true;

    const admission = await resolveExternalSessionOperationStartAdmission({
      activeServerDir,
      durableIdempotencyKey: 'concurrency-incoming-key',
      intent: {
        ...request,
        sessionId: 'concurrency-incoming-session',
        idempotencyKey: 'concurrency-incoming-key',
      },
    });

    expect(admission.kind).toBe('new_operation');
    expect(readFileBoundary.recordReads).toBe(128);
    // Serial admission peaks at one in-flight read; an unbounded fan-out peaks
    // at the whole inventory. The owner keeps the filesystem threadpool busy
    // without letting one Account's inventory dictate the descriptor count.
    expect(readFileBoundary.peakInFlightRecordReads).toBe(16);
    expect(readFileBoundary.inFlightRecordReads).toBe(0);
    // Overlapping reads must not reorder the inventory a serial read produced.
    await expect(listExternalSessionOperationRecords(activeServerDir))
      .resolves.toMatchObject(
        expectedOperationIds.map((operationId) => ({ operationId })),
      );
  });

  it('admits a new 10,001st record while retained operations remain readable and writable', async () => {
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
      operationId: 'external-takeover:over-limit-attempt',
      request: incomingRequest,
    } satisfies ExternalSessionOperationRecordV1;
    await expect(writeExternalSessionOperationRecord(
      activeServerDir,
      incoming,
    )).resolves.toEqual(incoming);
    await expect(fsPromises.stat(
      pathForRecord(activeServerDir, incoming.operationId),
    )).resolves.toBeDefined();

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
    )).resolves.toHaveLength(10_001);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      existingOperationId,
    )).resolves.toEqual(next);
  });


  it('retains replaced terminal idempotency identity and rejects its later semantic reuse', async () => {
    const activeServerDir = await createRoot();
    const initial = operationRecord();
    const { targetDirectory: _targetDirectory, ...materializeRequest } = request;
    const terminalRequest = {
      ...materializeRequest,
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
      operationId: 'external-materialize:retained-terminal-identity',
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
      operationId: 'external-takeover:retained-terminal-successor',
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

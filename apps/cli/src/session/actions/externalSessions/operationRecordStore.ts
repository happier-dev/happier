import { createHash } from 'node:crypto';
import { mkdir, opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  decideExternalSessionOperationUpdateV1,
  ExternalSessionOperationRecordV1Schema,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSemanticRequestV1,
  type ExternalSessionOperationUpdateDecisionV1,
} from '@happier-dev/protocol';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type ExternalSessionOperationRecordReadFailureReason =
  | 'malformed_json'
  | 'invalid_record'
  | 'read_failed';

export class ExternalSessionOperationRecordReadError extends Error {
  readonly reason: ExternalSessionOperationRecordReadFailureReason;
  readonly operationId: string;

  constructor(
    reason: ExternalSessionOperationRecordReadFailureReason,
    operationId: string,
    options?: ErrorOptions,
  ) {
    super(`external_session_operation_record_${reason}`, options);
    this.name = 'ExternalSessionOperationRecordReadError';
    this.reason = reason;
    this.operationId = operationId;
  }
}

export type ExternalSessionOperationRecordAdmissionFailureReason =
  | 'conflicting_operation'
  | 'inventory_unreadable'
  | 'inventory_too_large';

export class ExternalSessionOperationRecordAdmissionError extends Error {
  readonly reason: ExternalSessionOperationRecordAdmissionFailureReason;
  readonly operationId: string;

  constructor(
    reason: ExternalSessionOperationRecordAdmissionFailureReason,
    operationId: string,
    options?: ErrorOptions,
  ) {
    super(`external_session_operation_record_admission_${reason}`, options);
    this.name = 'ExternalSessionOperationRecordAdmissionError';
    this.reason = reason;
    this.operationId = operationId;
  }
}

export type ExternalSessionOperationRecordTransitionFailureReason = Exclude<
  ExternalSessionOperationUpdateDecisionV1['kind'],
  'accept' | 'duplicate'
> | 'progress_projection_regression'
  | 'progress_projection_mismatch';

export class ExternalSessionOperationRecordTransitionError extends Error {
  readonly reason: ExternalSessionOperationRecordTransitionFailureReason;
  readonly operationId: string;

  constructor(
    reason: ExternalSessionOperationRecordTransitionFailureReason,
    operationId: string,
  ) {
    super(`external_session_operation_record_${reason}`);
    this.name = 'ExternalSessionOperationRecordTransitionError';
    this.reason = reason;
    this.operationId = operationId;
  }
}

export type ExternalSessionOperationProgressProjectionAcknowledgementFailureReason =
  | 'invalid_projected_revision'
  | 'operation_not_found'
  | 'operation_mismatch'
  | 'projected_revision_ahead';

export class ExternalSessionOperationProgressProjectionAcknowledgementError
  extends Error {
  readonly reason:
    ExternalSessionOperationProgressProjectionAcknowledgementFailureReason;
  readonly operationId: string;

  constructor(
    reason:
      ExternalSessionOperationProgressProjectionAcknowledgementFailureReason,
    operationId: string,
  ) {
    super(`external_session_operation_progress_projection_${reason}`);
    this.name =
      'ExternalSessionOperationProgressProjectionAcknowledgementError';
    this.reason = reason;
    this.operationId = operationId;
  }
}

const MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY = 10_000;
const TERMINAL_OPERATION_STATUSES = new Set([
  'completed',
  'cancelled',
  'discarded',
]);

type ExternalSessionOperationAdmissionIdentity = Readonly<{
  sessionId: string;
  operationId: string;
  idempotencyKey: string;
}>;

type ExternalSessionOperationInventoryEntry = Readonly<{
  path: string;
  record: ExternalSessionOperationRecordV1;
}>;

function recordsDirectory(activeServerDir: string): string {
  return join(activeServerDir, 'external-session-operations', 'records');
}

function recordPath(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(
    activeServerDir,
    'external-session-operations',
    'records',
    `${key}.json`,
  );
}

function recordMutationLockPath(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(
    activeServerDir,
    'external-session-operations',
    'records',
    `${key}.mutation.lock`,
  );
}

function sessionAdmissionLockPath(activeServerDir: string, sessionId: string): string {
  const key = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return join(
    activeServerDir,
    'external-session-operations',
    'records',
    `${key}.session-admission.lock`,
  );
}

export async function withExternalSessionOperationSessionAdmissionLock<T>(
  activeServerDir: string,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(recordsDirectory(activeServerDir), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: sessionAdmissionLockPath(activeServerDir, sessionId),
    timeoutMs: 5_000,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode: 'external_session_operation_session_admission_lock_timeout',
  }, operation);
}

function inventoryAdmissionLockPath(activeServerDir: string): string {
  return join(
    activeServerDir,
    'external-session-operations',
    'records',
    '.inventory-admission.lock',
  );
}

function isErrorWithCode(
  error: unknown,
  code: string,
): error is Error & Readonly<{ code: string }> {
  return error instanceof Error
    && 'code' in error
    && error.code === code;
}

function parseExternalSessionOperationRecord(
  serialized: string,
  errorOperationId: string,
  expectedOperationId?: string,
): ExternalSessionOperationRecordV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch (error) {
    throw new ExternalSessionOperationRecordReadError(
      'malformed_json',
      errorOperationId,
      { cause: error },
    );
  }

  // Current dev operation rows predate the private projection receipt. This is
  // deliberately local to the CLI record owner; no released/predecessor shape
  // or cross-component compatibility adapter is implied.
  const reconciled = (
    decoded
    && typeof decoded === 'object'
    && !Array.isArray(decoded)
    && 'v' in decoded
    && decoded.v === 1
    && !Object.hasOwn(decoded, 'progressProjection')
  )
    ? {
      ...decoded,
      progressProjection: { acknowledgedRevision: null },
    }
    : decoded;
  const parsed = ExternalSessionOperationRecordV1Schema.safeParse(reconciled);
  if (!parsed.success) {
    throw new ExternalSessionOperationRecordReadError(
      'invalid_record',
      errorOperationId,
    );
  }
  if (
    expectedOperationId !== undefined
    && parsed.data.operationId !== expectedOperationId
  ) {
    throw new ExternalSessionOperationRecordReadError(
      'invalid_record',
      errorOperationId,
    );
  }
  return parsed.data;
}

async function readExternalSessionOperationRecordInventory(
  activeServerDir: string,
  errorOperationId: string,
): Promise<readonly ExternalSessionOperationInventoryEntry[]> {
  const directoryPath = recordsDirectory(activeServerDir);
  const records: ExternalSessionOperationInventoryEntry[] = [];
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return records;
    }
    throw new ExternalSessionOperationRecordAdmissionError(
      'inventory_unreadable',
      errorOperationId,
      { cause: error },
    );
  }

  let recordCount = 0;
  try {
    for await (const entry of directory) {
      if (!entry.name.endsWith('.json')) continue;
      recordCount += 1;
      if (recordCount > MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY) {
        throw new ExternalSessionOperationRecordAdmissionError(
          'inventory_too_large',
          errorOperationId,
        );
      }
      if (!entry.isFile()) {
        throw new ExternalSessionOperationRecordAdmissionError(
          'inventory_unreadable',
          errorOperationId,
        );
      }
      const path = join(directoryPath, entry.name);
      let record: ExternalSessionOperationRecordV1;
      try {
        const serialized = await readFile(path, 'utf8');
        record = parseExternalSessionOperationRecord(
          serialized,
          errorOperationId,
        );
      } catch (error) {
        if (isErrorWithCode(error, 'ENOENT')) {
          continue;
        }
        throw new ExternalSessionOperationRecordAdmissionError(
          'inventory_unreadable',
          errorOperationId,
          { cause: error },
        );
      }
      if (recordPath(activeServerDir, record.operationId) !== path) {
        throw new ExternalSessionOperationRecordAdmissionError(
          'inventory_unreadable',
          errorOperationId,
        );
      }
      records.push({ path, record });
    }
  } catch (error) {
    if (error instanceof ExternalSessionOperationRecordAdmissionError) {
      throw error;
    }
    throw new ExternalSessionOperationRecordAdmissionError(
      'inventory_unreadable',
      errorOperationId,
      { cause: error },
    );
  }
  return records;
}

async function scanExternalSessionOperationRecordAdmission(
  activeServerDir: string,
  incoming: ExternalSessionOperationAdmissionIdentity,
): Promise<readonly ExternalSessionOperationRecordV1[]> {
  const inventory = await readExternalSessionOperationRecordInventory(
    activeServerDir,
    incoming.operationId,
  );
  const replaceableTerminalRecords: ExternalSessionOperationRecordV1[] = [];
  const containsIncomingOperation = inventory.some(
    ({ record }) => record.operationId === incoming.operationId,
  );
  if (
    !containsIncomingOperation
    && inventory.length >= MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY
  ) {
    throw new ExternalSessionOperationRecordAdmissionError(
      'inventory_too_large',
      incoming.operationId,
    );
  }
  for (const { record } of inventory) {
    if (
      record.request.sessionId !== incoming.sessionId
      || record.operationId === incoming.operationId
    ) {
      continue;
    }
    if (record.request.idempotencyKey === incoming.idempotencyKey) {
      throw new ExternalSessionOperationRecordAdmissionError(
        'conflicting_operation',
        incoming.operationId,
      );
    }
    if (!TERMINAL_OPERATION_STATUSES.has(record.status)) {
      throw new ExternalSessionOperationRecordAdmissionError(
        'conflicting_operation',
        incoming.operationId,
      );
    }
    replaceableTerminalRecords.push(record);
  }
  return replaceableTerminalRecords;
}

export async function assertExternalSessionOperationRecordAdmission(
  activeServerDir: string,
  incoming: ExternalSessionOperationAdmissionIdentity,
): Promise<void> {
  await scanExternalSessionOperationRecordAdmission(activeServerDir, incoming);
}

export async function listExternalSessionOperationRecords(
  activeServerDir: string,
): Promise<readonly ExternalSessionOperationRecordV1[]> {
  const inventory = await readExternalSessionOperationRecordInventory(
    activeServerDir,
    'inventory',
  );
  return inventory.map(({ record }) => record);
}

export function externalSessionOperationIdForRequest(
  request: Readonly<{
    sessionId: string;
    idempotencyKey: string;
    plan: ExternalSessionOperationSemanticRequestV1['plan'];
  }>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey,
    }), 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `external-${request.plan}:${digest}`;
}

export async function readExternalSessionOperationRecord(
  activeServerDir: string,
  operationId: string,
): Promise<ExternalSessionOperationRecordV1 | null> {
  let serialized: string;
  try {
    serialized = await readFile(recordPath(activeServerDir, operationId), 'utf8');
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return null;
    }
    throw new ExternalSessionOperationRecordReadError(
      'read_failed',
      operationId,
      { cause: error },
    );
  }

  return parseExternalSessionOperationRecord(
    serialized,
    operationId,
    operationId,
  );
}

export async function writeExternalSessionOperationRecord(
  activeServerDir: string,
  record: ExternalSessionOperationRecordV1,
  options: Readonly<{
    validateCurrent?: (
      current: ExternalSessionOperationRecordV1 | null,
      incoming: ExternalSessionOperationRecordV1,
    ) => void;
    validateSessionAdmission?: (
      current: ExternalSessionOperationRecordV1 | null,
      incoming: ExternalSessionOperationRecordV1,
    ) => void | Promise<void>;
    settlePriorTerminalProgressProjection?: (
      priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
      incoming: ExternalSessionOperationRecordV1,
    ) => void | Promise<void>;
  }> = {},
): Promise<ExternalSessionOperationRecordV1> {
  const parsed = ExternalSessionOperationRecordV1Schema.parse(record);
  const path = recordPath(activeServerDir, parsed.operationId);
  await mkdir(recordsDirectory(activeServerDir), {
    recursive: true,
    mode: 0o700,
  });
  const writeUnderRecordLock = async (): Promise<ExternalSessionOperationRecordV1> => {
    return await withJsonOwnerFileLock({
      lockPath: recordMutationLockPath(activeServerDir, parsed.operationId),
      timeoutMs: 5_000,
      staleAfterMs: 30_000,
      pollIntervalMs: 5,
      errorCode: 'external_session_operation_record_lock_timeout',
    }, async () => {
      const current = await readExternalSessionOperationRecord(
        activeServerDir,
        parsed.operationId,
      );
      options.validateCurrent?.(current, parsed);
      assertSemanticProgressProjectionPreserved(
        current,
        parsed,
      );
      const updateDecision = current
        ? decideExternalSessionOperationUpdateV1(current, parsed)
        : null;
      if (
        updateDecision
        && updateDecision.kind !== 'accept'
        && updateDecision.kind !== 'duplicate'
      ) {
        throw new ExternalSessionOperationRecordTransitionError(
          updateDecision.kind,
          parsed.operationId,
        );
      }
      if (!current) {
        const priorTerminalRecords =
          await scanExternalSessionOperationRecordAdmission(
            activeServerDir,
            {
              sessionId: parsed.request.sessionId,
              operationId: parsed.operationId,
              idempotencyKey: parsed.request.idempotencyKey,
            },
          );
        await options.settlePriorTerminalProgressProjection?.(
          priorTerminalRecords,
          parsed,
        );
        await options.validateSessionAdmission?.(current, parsed);
        return await withJsonOwnerFileLock({
          lockPath: inventoryAdmissionLockPath(activeServerDir),
          timeoutMs: 5_000,
          staleAfterMs: 30_000,
          pollIntervalMs: 5,
          errorCode:
            'external_session_operation_inventory_admission_lock_timeout',
        }, async () => {
          await scanExternalSessionOperationRecordAdmission(
            activeServerDir,
            {
              sessionId: parsed.request.sessionId,
              operationId: parsed.operationId,
              idempotencyKey: parsed.request.idempotencyKey,
            },
          );
          await writeJsonAtomic(path, parsed);
          return parsed;
        });
      }
      await options.validateSessionAdmission?.(current, parsed);
      if (current && updateDecision?.kind === 'duplicate') {
        return current;
      }
      await writeJsonAtomic(path, parsed);
      return parsed;
    });
  };
  return await withExternalSessionOperationSessionAdmissionLock(
    activeServerDir,
    parsed.request.sessionId,
    writeUnderRecordLock,
  );
}

export async function mutateExternalSessionOperationRecordAtRevision(
  activeServerDir: string,
  operationId: string,
  expectedRevision: number,
  mutate: (
    current: ExternalSessionOperationRecordV1,
  ) => ExternalSessionOperationRecordV1,
): Promise<
  | Readonly<{ ok: true; record: ExternalSessionOperationRecordV1 }>
  | Readonly<{ ok: false; code: 'operation_not_found' | 'stale_revision' }>
> {
  await mkdir(recordsDirectory(activeServerDir), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: recordMutationLockPath(activeServerDir, operationId),
    timeoutMs: 5_000,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode: 'external_session_operation_record_lock_timeout',
  }, async () => {
    const current = await readExternalSessionOperationRecord(activeServerDir, operationId);
    if (!current) return { ok: false as const, code: 'operation_not_found' as const };
    if (current.revision !== expectedRevision) {
      return { ok: false as const, code: 'stale_revision' as const };
    }
    const next = ExternalSessionOperationRecordV1Schema.parse(mutate(current));
    assertSemanticProgressProjectionPreserved(current, next);
    const updateDecision = decideExternalSessionOperationUpdateV1(current, next);
    if (
      updateDecision.kind !== 'accept'
      && updateDecision.kind !== 'duplicate'
    ) {
      throw new ExternalSessionOperationRecordTransitionError(
        updateDecision.kind,
        operationId,
      );
    }
    if (updateDecision.kind === 'duplicate') {
      return { ok: true as const, record: current };
    }
    await writeJsonAtomic(recordPath(activeServerDir, operationId), next);
    return { ok: true as const, record: next };
  });
}

function assertSemanticProgressProjectionPreserved(
  current: ExternalSessionOperationRecordV1 | null,
  incoming: ExternalSessionOperationRecordV1,
): void {
  const currentAcknowledgement =
    current?.progressProjection.acknowledgedRevision ?? null;
  const incomingAcknowledgement =
    incoming.progressProjection.acknowledgedRevision;
  if (!current) {
    if (incomingAcknowledgement !== null) {
      throw new ExternalSessionOperationRecordTransitionError(
        'progress_projection_mismatch',
        incoming.operationId,
      );
    }
    return;
  }
  if (incomingAcknowledgement === currentAcknowledgement) return;
  if (
    currentAcknowledgement !== null
    && (
      incomingAcknowledgement === null
      || incomingAcknowledgement < currentAcknowledgement
    )
  ) {
    throw new ExternalSessionOperationRecordTransitionError(
      'progress_projection_regression',
      incoming.operationId,
    );
  }
  throw new ExternalSessionOperationRecordTransitionError(
    'progress_projection_mismatch',
    incoming.operationId,
  );
}

export async function acknowledgeExternalSessionOperationProgressProjection(
  input: Readonly<{
    activeServerDir: string;
    operationId: string;
    projectedRevision: number;
  }>,
): Promise<ExternalSessionOperationRecordV1> {
  if (
    !Number.isSafeInteger(input.projectedRevision)
    || input.projectedRevision < 0
  ) {
    throw new ExternalSessionOperationProgressProjectionAcknowledgementError(
      'invalid_projected_revision',
      input.operationId,
    );
  }
  await mkdir(recordsDirectory(input.activeServerDir), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: recordMutationLockPath(
      input.activeServerDir,
      input.operationId,
    ),
    timeoutMs: 5_000,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode: 'external_session_operation_record_lock_timeout',
  }, async () => {
    let current: ExternalSessionOperationRecordV1 | null;
    try {
      current = await readExternalSessionOperationRecord(
        input.activeServerDir,
        input.operationId,
      );
    } catch (error) {
      if (
        error instanceof ExternalSessionOperationRecordReadError
        && error.reason === 'invalid_record'
      ) {
        throw new ExternalSessionOperationProgressProjectionAcknowledgementError(
          'operation_mismatch',
          input.operationId,
        );
      }
      throw error;
    }
    if (!current) {
      throw new ExternalSessionOperationProgressProjectionAcknowledgementError(
        'operation_not_found',
        input.operationId,
      );
    }
    if (current.operationId !== input.operationId) {
      throw new ExternalSessionOperationProgressProjectionAcknowledgementError(
        'operation_mismatch',
        input.operationId,
      );
    }
    if (input.projectedRevision > current.revision) {
      throw new ExternalSessionOperationProgressProjectionAcknowledgementError(
        'projected_revision_ahead',
        input.operationId,
      );
    }
    const acknowledgedRevision =
      current.progressProjection.acknowledgedRevision;
    if (
      acknowledgedRevision !== null
      && input.projectedRevision <= acknowledgedRevision
    ) {
      return current;
    }
    const acknowledged =
      ExternalSessionOperationRecordV1Schema.parse({
        ...current,
        progressProjection: {
          acknowledgedRevision: input.projectedRevision,
        },
      });
    await writeJsonAtomic(
      recordPath(input.activeServerDir, input.operationId),
      acknowledged,
    );
    return acknowledged;
  });
}

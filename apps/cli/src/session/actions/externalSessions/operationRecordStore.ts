import { createHash, randomUUID } from 'node:crypto';
import { mkdir, opendir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  decideExternalSessionOperationUpdateV1,
  externalSessionOperationRetainsDiscardRecoveryV1,
  isExternalSessionOperationTerminalStatusV1,
  ExternalSessionOperationAuthorIntentV1Schema,
  ExternalSessionOperationReferenceV1Schema,
  ExternalSessionOperationRecordV1Schema,
  ExternalSessionOperationSharedPresentationV1Schema,
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationReferenceV1,
  type ExternalSessionOperationAuthorIntentV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSemanticRequestV1,
  type ExternalSessionOperationSharedPresentationV1,
  type ExternalSessionMaterializeStartInputV1,
  type ExternalSessionTakeoverStartInputV1,
  type ExternalSessionOperationUpdateDecisionV1,
} from '@happier-dev/protocol';

import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { readStoredCredentials } from '@/persistence';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type ExternalSessionOperationRecordReadFailureReason =
  | 'malformed_json'
  | 'invalid_record'
  | 'read_failed'
  | 'account_scope_unavailable'
  | 'legacy_unscoped';

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
  | 'inventory_too_large'
  | 'legacy_unavailable';

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
  | 'progress_projection_mismatch'
  | 'compacted_record';

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
const EXTERNAL_SESSION_OPERATION_INVENTORY_LOCK_TIMEOUT_MS = 30_000;
const EXTERNAL_SESSION_OPERATION_TERMINAL_RECEIPT_RETENTION_MS =
  24 * 60 * 60 * 1_000;

export type ExternalSessionOperationAccountScope = Readonly<{
  activeServerDir: string;
  accountSubject: string;
}>;

function accountDirectoryName(subject: string): string {
  return `sub-${createHash('sha256')
    .update(subject, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * Durable operation identity is bound to the authenticated Account subject,
 * not to a refreshable bearer token or to the server's local data directory.
 */
export function resolveExternalSessionOperationAccountScope(
  activeServerDir: string,
  token: string,
): ExternalSessionOperationAccountScope | null {
  const payload = decodeJwtPayload(token.trim());
  const subject = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  return subject
    ? { activeServerDir, accountSubject: subject }
    : null;
}

/**
 * Capture the authenticated Account scope at operation admission. Start owners
 * call this once per admission and carry the returned pin into every record,
 * staging, and exclusion effect of the operation; those effects verify the
 * ambient Account still matches the pin, so an A→B rotation fails closed
 * instead of silently resolving into B's partition. Null means no
 * authenticated Account is currently available; admission then resolves
 * ambient and fails closed in production exactly as before.
 */
export async function resolveExternalSessionOperationAdmissionAccountScope(
  activeServerDir: string,
): Promise<ExternalSessionOperationAccountScope | null> {
  const credentials = await readStoredCredentials();
  return credentials
    ? resolveExternalSessionOperationAccountScope(
      activeServerDir,
      credentials.token,
    )
    : null;
}

function isScopedRecordsDirectory(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.includes('/external-session-operations/by-account/')
    && normalized.endsWith('/records');
}

function legacyRecordsDirectory(activeServerDir: string): string {
  return join(activeServerDir, 'external-session-operations', 'records');
}

function legacyRecordPath(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(legacyRecordsDirectory(activeServerDir), `${key}.json`);
}

/**
 * Every durable artefact an operation owns — its record row and its
 * operation-private staging — lives under one Account partition, so retained
 * work of one Account can never be read by, or consume the capacity of,
 * another Account on the same daemon.
 */
function accountPartitionDirectory(
  scope: ExternalSessionOperationAccountScope,
): string {
  return join(
    scope.activeServerDir,
    'external-session-operations',
    'by-account',
    accountDirectoryName(scope.accountSubject),
  );
}

function recordsDirectoryForAccountScope(
  scope: ExternalSessionOperationAccountScope,
): string {
  return join(accountPartitionDirectory(scope), 'records');
}

async function resolveCurrentExternalSessionOperationAccountScope(
  activeServerDir: string,
  operationId: string,
  accountScope?: ExternalSessionOperationAccountScope,
): Promise<ExternalSessionOperationAccountScope> {
  if (accountScope) {
    if (accountScope.activeServerDir !== activeServerDir) {
      throw new ExternalSessionOperationRecordReadError(
        'account_scope_unavailable',
        operationId,
      );
    }
    // Fail closed before any effect when the ambient authenticated Account no
    // longer matches the scope pinned at operation admission: an A→B
    // credential rotation must never let Account A's in-flight operation
    // resolve into Account B's partition.
    const credentials = await readStoredCredentials();
    const ambientScope = credentials
      ? resolveExternalSessionOperationAccountScope(
        activeServerDir,
        credentials.token,
      )
      : null;
    if (!ambientScope || ambientScope.accountSubject !== accountScope.accountSubject) {
      throw new ExternalSessionOperationRecordReadError(
        'account_scope_unavailable',
        operationId,
      );
    }
    return accountScope;
  }
  const credentials = await readStoredCredentials();
  const scope = credentials
    ? resolveExternalSessionOperationAccountScope(
      activeServerDir,
      credentials.token,
    )
    : null;
  if (scope) return scope;
  // The test harness intentionally supplies no persisted credentials for its
  // pure record-store fixtures. Production never receives this fallback.
  if (process.env.VITEST) {
    return { activeServerDir, accountSubject: 'vitest' };
  }
  throw new ExternalSessionOperationRecordReadError(
    'account_scope_unavailable',
    operationId,
  );
}

async function resolveExternalSessionOperationRecordsDirectory(
  activeServerDir: string,
  operationId: string,
  accountScope?: ExternalSessionOperationAccountScope,
): Promise<string> {
  if (isScopedRecordsDirectory(activeServerDir)) return activeServerDir;
  return recordsDirectoryForAccountScope(
    await resolveCurrentExternalSessionOperationAccountScope(
      activeServerDir,
      operationId,
      accountScope,
    ),
  );
}
/**
 * Operation-private staging shares the operation record's Account partition.
 * Staging written before Account partitioning stays where it is: it is never
 * read, replayed, or counted for any Account, and the operation that owned it
 * reports its staging as missing and recaptures. That development-only
 * disposition is deliberate — an unscoped manifest carries no ownership proof,
 * so adopting it into the current Account would be a cross-Account read.
 */
export async function resolveExternalSessionOperationStagingDirectory(
  activeServerDir: string,
  operationId: string,
  accountScope?: ExternalSessionOperationAccountScope,
): Promise<string> {
  return join(
    accountPartitionDirectory(
      await resolveCurrentExternalSessionOperationAccountScope(
        activeServerDir,
        operationId,
        accountScope,
      ),
    ),
    'staging',
  );
}

/**
 * Retirement-path staging resolution: derives the pinned scope's private
 * staging directory directly, deliberately without the ambient-credential
 * verification the live read/write paths enforce. Only the durable
 * Session-deletion retirement path may use it — the deletion fact itself
 * proves ownership, so requiring the ambient Account to match would defer
 * cleanup until the owning Account re-authenticates while the unlinked record
 * orphans the private payload forever. Live paths must keep using
 * resolveExternalSessionOperationStagingDirectory.
 */
export function resolveExternalSessionOperationRetirementStagingDirectory(
  scope: ExternalSessionOperationAccountScope,
): string {
  return join(accountPartitionDirectory(scope), 'staging');
}

type ExternalSessionOperationAdmissionIdentity = Readonly<{
  sessionId: string;
  operationId: string;
  idempotencyKey: string;
  intentDigest?: string;
  authorIntent?: ExternalSessionOperationAuthorIntentV1;
  nowMs?: number;
}>;

export type ExternalSessionOperationPriorTerminalReceiptEvidence = Readonly<{
  reference: ExternalSessionOperationReferenceV1;
  presentation: ExternalSessionOperationSharedPresentationV1;
}>;

export type ExternalSessionOperationSelectedPresentationRead = Readonly<
  | { kind: 'gone' }
  | { kind: 'absent' }
  | {
    kind: 'valid';
    presentation: ExternalSessionOperationSharedPresentationV1;
  }
  | { kind: 'malformed' }
>;

export type ExternalSessionOperationSelectedPresentationReader = (
  sessionId: string,
) => Promise<ExternalSessionOperationSelectedPresentationRead>;

type ExternalSessionOperationAdmissionScan = Readonly<{
  priorTerminalRecords: readonly ExternalSessionOperationRecordV1[];
  priorTerminalReceiptEvidence:
    readonly ExternalSessionOperationPriorTerminalReceiptEvidence[];
  convergedRecord?: ExternalSessionOperationRecordV1;
  convergedReceipt?: ExternalSessionOperationTerminalReceiptV1;
}>;

const ExternalSessionOperationTerminalReceiptV1Schema = z.object({
  v: z.literal(1),
  recordKind: z.literal('terminal_receipt'),
  reference: ExternalSessionOperationReferenceV1Schema,
  presentation: ExternalSessionOperationSharedPresentationV1Schema,
  durableIdempotencyKey: z.string().min(1).max(256).refine(
    (value) => value === value.trim(),
    'Terminal receipt idempotency keys must be trim-equal.',
  ),
  idempotencyIntentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  authorIntent: ExternalSessionOperationAuthorIntentV1Schema.optional(),
  terminalAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((receipt, context) => {
  if (
    receipt.reference.operationId !== receipt.presentation.operationId
    || receipt.reference.revision !== receipt.presentation.revision
  ) {
    context.addIssue({
      code: 'custom',
      path: ['presentation'],
      message: 'Terminal receipt presentation must match its operation reference.',
    });
  }
  if (!isExternalSessionOperationTerminalStatusV1(receipt.presentation.status)) {
    context.addIssue({
      code: 'custom',
      path: ['presentation', 'status'],
      message: 'Terminal receipt presentation must be settled.',
    });
  }
  if (
    receipt.authorIntent?.kind === 'takeover'
    && receipt.presentation.kind !== `takeover_${receipt.authorIntent.targetStorageMode.replace('-', '_')}`
  ) {
    context.addIssue({
      code: 'custom',
      path: ['authorIntent'],
      message: 'Terminal receipt takeover intent must match its presentation.',
    });
  }
  if (
    receipt.authorIntent?.kind === 'materialize'
    && (
      receipt.reference.sessionId !== receipt.authorIntent.sessionId
      || receipt.presentation.kind !== 'materialize'
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['authorIntent'],
      message: 'Terminal receipt materialize intent must match its reference and presentation.',
    });
  }
  if (
    receipt.terminalAtMs
      > Number.MAX_SAFE_INTEGER
        - EXTERNAL_SESSION_OPERATION_TERMINAL_RECEIPT_RETENTION_MS
    || receipt.expiresAtMs !== receipt.terminalAtMs
      + EXTERNAL_SESSION_OPERATION_TERMINAL_RECEIPT_RETENTION_MS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAtMs'],
      message: 'Terminal receipt expiry must be exactly 24 hours after terminalization.',
    });
  }
});

export type ExternalSessionOperationTerminalReceiptV1 = z.infer<
  typeof ExternalSessionOperationTerminalReceiptV1Schema
>;

export type ExternalSessionOperationStoredEntry = Readonly<
  | {
    kind: 'full_record';
    record: ExternalSessionOperationRecordV1;
  }
  | {
    kind: 'terminal_receipt';
    receipt: ExternalSessionOperationTerminalReceiptV1;
  }
>;

type ExternalSessionOperationInventoryEntry = Readonly<{
  path: string;
  entry: ExternalSessionOperationStoredEntry;
}>;

function recordsDirectory(activeServerDir: string): string {
  return isScopedRecordsDirectory(activeServerDir)
    ? activeServerDir
    : legacyRecordsDirectory(activeServerDir);
}

function recordPath(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(recordsDirectory(activeServerDir), `${key}.json`);
}

function recordMutationLockPath(activeServerDir: string, operationId: string): string {
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  return join(recordsDirectory(activeServerDir), `${key}.mutation.lock`);
}

function sessionAdmissionLockPath(activeServerDir: string, sessionId: string): string {
  const key = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return join(recordsDirectory(activeServerDir), `${key}.session-admission.lock`);
}

export async function withExternalSessionOperationSessionAdmissionLock<T>(
  activeServerDir: string,
  sessionId: string,
  operation: () => Promise<T>,
  accountScope?: ExternalSessionOperationAccountScope,
): Promise<T> {
  const recordsDirectoryPath =
    await resolveExternalSessionOperationRecordsDirectory(
      activeServerDir,
      `session-admission:${sessionId}`,
      accountScope,
    );
  await mkdir(recordsDirectory(recordsDirectoryPath), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: sessionAdmissionLockPath(recordsDirectoryPath, sessionId),
    timeoutMs: 5_000,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode: 'external_session_operation_session_admission_lock_timeout',
  }, operation);
}

function inventoryAdmissionLockPath(activeServerDir: string): string {
  return join(recordsDirectory(activeServerDir), '.inventory-admission.lock');
}

function isErrorWithCode(
  error: unknown,
  code: string,
): error is Error & Readonly<{ code: string }> {
  return error instanceof Error
    && 'code' in error
    && error.code === code;
}

function parseExternalSessionOperationStoredEntry(
  serialized: string,
  errorOperationId: string,
  expectedOperationId?: string,
): ExternalSessionOperationStoredEntry {
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

  if (
    decoded
    && typeof decoded === 'object'
    && !Array.isArray(decoded)
    && 'recordKind' in decoded
    && decoded.recordKind === 'terminal_receipt'
  ) {
    const reference = 'reference' in decoded
      && decoded.reference
      && typeof decoded.reference === 'object'
      && !Array.isArray(decoded.reference)
      ? decoded.reference
      : null;
    const presentation = 'presentation' in decoded
      && decoded.presentation
      && typeof decoded.presentation === 'object'
      && !Array.isArray(decoded.presentation)
      ? decoded.presentation
      : null;
    const identities = [
      reference && 'sessionId' in reference ? reference.sessionId : undefined,
      reference && 'operationId' in reference
        ? reference.operationId
        : undefined,
      presentation && 'operationId' in presentation
        ? presentation.operationId
        : undefined,
    ];
    if (identities.some(
      (identity) => typeof identity === 'string'
        && identity !== identity.trim(),
    )) {
      throw new ExternalSessionOperationRecordReadError(
        'invalid_record',
        errorOperationId,
      );
    }
  }

  const receipt = ExternalSessionOperationTerminalReceiptV1Schema.safeParse(
    decoded,
  );
  if (receipt.success) {
    if (
      expectedOperationId !== undefined
      && receipt.data.reference.operationId !== expectedOperationId
    ) {
      throw new ExternalSessionOperationRecordReadError(
        'invalid_record',
        errorOperationId,
      );
    }
    return { kind: 'terminal_receipt', receipt: receipt.data };
  }

  const parsed = ExternalSessionOperationRecordV1Schema.safeParse(decoded);
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
  return { kind: 'full_record', record: parsed.data };
}

/**
 * An inventory row is its own small file, so a whole-inventory read is one
 * independent open/read/close per row. Awaiting them one at a time pays the
 * full filesystem round trip 10,000 times over and does it while the caller
 * holds the Account inventory-admission lock.
 *
 * The bound is the filesystem itself: Node dispatches these reads to the libuv
 * threadpool (four threads by default), so a handful of requests in flight
 * already keeps every thread busy while the rest queue. Sixteen leaves that
 * pool saturated across the event-loop turnaround without approaching any
 * platform's descriptor limit — the smallest common soft limit is 256, and
 * each in-flight read holds at most one descriptor.
 */
const EXTERNAL_SESSION_OPERATION_INVENTORY_READ_CONCURRENCY = 16;

/**
 * Reads each entry with bounded concurrency and keeps the results in the
 * caller's index order, so inventory order stays exactly the directory order
 * a serial read produced. `read` returns `null` for a row that vanished
 * between the directory walk and its read.
 */
async function readEntriesWithBoundedConcurrency<TEntry, TValue>(
  entries: readonly TEntry[],
  read: (entry: TEntry) => Promise<TValue | null>,
): Promise<readonly TValue[]> {
  const results = new Array<TValue | null>(entries.length).fill(null);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      try {
        results[index] = await read(entries[index] as TEntry);
      } catch (error) {
        // One unreadable row fails the whole inventory closed, exactly as the
        // serial reader did; the remaining workers stop instead of reading
        // rows whose result is already discarded.
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from(
    {
      length: Math.min(
        EXTERNAL_SESSION_OPERATION_INVENTORY_READ_CONCURRENCY,
        entries.length,
      ),
    },
    () => worker(),
  ));
  if (failed) throw failure;
  return results.filter((value): value is TValue => value !== null);
}

async function readExternalSessionOperationRecordInventory(
  activeServerDir: string,
  errorOperationId: string,
): Promise<readonly ExternalSessionOperationInventoryEntry[]> {
  const directoryPath = recordsDirectory(activeServerDir);
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return [];
    }
    throw new ExternalSessionOperationRecordAdmissionError(
      'inventory_unreadable',
      errorOperationId,
      { cause: error },
    );
  }

  const paths: string[] = [];
  try {
    for await (const entry of directory) {
      if (!entry.name.endsWith('.json')) continue;
      if (paths.length + 1 > MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY) {
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
      paths.push(join(directoryPath, entry.name));
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

  return await readEntriesWithBoundedConcurrency(paths, async (path) => {
    let storedEntry: ExternalSessionOperationStoredEntry;
    try {
      const serialized = await readFile(path, 'utf8');
      storedEntry = parseExternalSessionOperationStoredEntry(
        serialized,
        errorOperationId,
      );
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) {
        return null;
      }
      throw new ExternalSessionOperationRecordAdmissionError(
        'inventory_unreadable',
        errorOperationId,
        { cause: error },
      );
    }
    const operationId = storedEntry.kind === 'full_record'
      ? storedEntry.record.operationId
      : storedEntry.receipt.reference.operationId;
    if (recordPath(activeServerDir, operationId) !== path) {
      throw new ExternalSessionOperationRecordAdmissionError(
        'inventory_unreadable',
        errorOperationId,
      );
    }
    return { path, entry: storedEntry };
  });
}

/**
 * Rows written before Account-scoped storage had no ownership proof. They are
 * never replayed or counted toward a current Account; only an exact durable
 * idempotency collision is quarantined so it cannot create a second owner.
 */
async function hasMatchingLegacyOperationIdentity(
  activeServerDir: string,
  durableIdempotencyKey: string,
): Promise<boolean> {
  const directoryPath = legacyRecordsDirectory(activeServerDir);
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch {
    // No legacy directory (or none readable at all) means no legacy owner can
    // be proven. Exact direct operation-id reads still fail closed.
    return false;
  }
  try {
    for await (const entry of directory) {
      if (!entry.name.endsWith('.json') || !entry.isFile()) continue;
      // Each legacy row is parsed independently: a malformed unrelated row
      // loses only its own evidence and must not hide a valid exact match.
      let storedEntry: ExternalSessionOperationStoredEntry;
      try {
        storedEntry = parseExternalSessionOperationStoredEntry(
          await readFile(join(directoryPath, entry.name), 'utf8'),
          'legacy-operation-identity',
        );
      } catch {
        continue;
      }
      const matches = storedEntry.kind === 'terminal_receipt'
        ? storedEntry.receipt.durableIdempotencyKey === durableIdempotencyKey
        : storedEntry.record.request.idempotencyKey === durableIdempotencyKey;
      if (matches) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function hasLegacyOperationId(
  activeServerDir: string,
  operationId: string,
): Promise<boolean> {
  try {
    await readFile(legacyRecordPath(activeServerDir, operationId), 'utf8');
    return true;
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return false;
    // An unreadable legacy identity cannot be safely treated as absent.
    return true;
  }
}

async function scanExternalSessionOperationRecordAdmission(
  activeServerDir: string,
  incoming: ExternalSessionOperationAdmissionIdentity,
): Promise<ExternalSessionOperationAdmissionScan> {
  const inventory = await readExternalSessionOperationRecordInventory(
    activeServerDir,
    incoming.operationId,
  );
  const replaceableTerminalRecords: ExternalSessionOperationRecordV1[] = [];
  const priorTerminalReceiptEvidence:
    ExternalSessionOperationPriorTerminalReceiptEvidence[] = [];
  let convergedRecord: ExternalSessionOperationRecordV1 | undefined;
  let convergedReceipt:
    ExternalSessionOperationTerminalReceiptV1 | undefined;
  const incomingIntentDigest = incoming.intentDigest;
  const nowMs = incoming.nowMs ?? Date.now();
  const containsIncomingOperation = inventory.some(
    ({ entry }) => (
      entry.kind === 'full_record'
        ? entry.record.operationId
        : entry.receipt.reference.operationId
    ) === incoming.operationId,
  );
  for (const { entry } of inventory) {
    if (entry.kind === 'terminal_receipt') {
      const receipt = entry.receipt;
      const expired = isExternalSessionOperationTerminalReceiptExpired(
        receipt,
        nowMs,
      );
      if (
        receipt.durableIdempotencyKey === incoming.idempotencyKey
        && !expired
        && externalSessionOperationCallerNamespaceMatches(
          receipt.authorIntent,
          incoming.authorIntent,
        )
      ) {
        if (
          !externalSessionOperationIntentEvidenceMatches(
            {
              ...(receipt.authorIntent
                ? { authorIntent: receipt.authorIntent }
                : {}),
              intentDigest: receipt.idempotencyIntentDigest,
            },
            {
              ...(incoming.authorIntent
                ? { authorIntent: incoming.authorIntent }
                : {}),
              intentDigest: incomingIntentDigest,
            },
          )
          || convergedRecord
          || convergedReceipt
        ) {
          throw new ExternalSessionOperationRecordAdmissionError(
            'conflicting_operation',
            incoming.operationId,
          );
        }
        convergedReceipt = receipt;
      }
      if (
        receipt.reference.sessionId === incoming.sessionId
        && receipt.reference.operationId !== incoming.operationId
      ) {
        priorTerminalReceiptEvidence.push({
          reference: receipt.reference,
          presentation: receipt.presentation,
        });
      }
      continue;
    }
    const { record } = entry;
    if (
      record.request.idempotencyKey === incoming.idempotencyKey
      && externalSessionOperationCallerNamespaceMatches(
        record.authorIntent,
        incoming.authorIntent,
      )
    ) {
      if (
        !externalSessionOperationIntentEvidenceMatches(
          {
            ...(record.authorIntent
              ? { authorIntent: record.authorIntent }
              : {}),
            intentDigest: idempotencyIntentDigestForRequest(record.request),
          },
          {
            ...(incoming.authorIntent
              ? { authorIntent: incoming.authorIntent }
              : {}),
            intentDigest: incomingIntentDigest,
          },
        )
        || convergedRecord
        || convergedReceipt
      ) {
        throw new ExternalSessionOperationRecordAdmissionError(
          'conflicting_operation',
          incoming.operationId,
        );
      }
      convergedRecord = record;
    }
    if (
      record.request.sessionId !== incoming.sessionId
      || record.operationId === incoming.operationId
    ) {
      continue;
    }
    if (
      record.request.idempotencyKey === incoming.idempotencyKey
      && externalSessionOperationCallerNamespaceMatches(
        record.authorIntent,
        incoming.authorIntent,
      )
    ) continue;
    if (!isExternalSessionOperationTerminalStatusV1(record.status)) {
      throw new ExternalSessionOperationRecordAdmissionError(
        'conflicting_operation',
        incoming.operationId,
      );
    }
    replaceableTerminalRecords.push(record);
  }
  if (
    !containsIncomingOperation
    && !convergedRecord
    && !convergedReceipt
    && inventory.length
      >= MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY
  ) {
    throw new ExternalSessionOperationRecordAdmissionError(
      'inventory_too_large',
      incoming.operationId,
    );
  }
  return {
    priorTerminalRecords: replaceableTerminalRecords,
    priorTerminalReceiptEvidence,
    ...(convergedRecord ? { convergedRecord } : {}),
    ...(convergedReceipt ? { convergedReceipt } : {}),
  };
}

export async function assertExternalSessionOperationRecordAdmission(
  activeServerDir: string,
  incoming: ExternalSessionOperationAdmissionIdentity,
): Promise<void> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      activeServerDir,
      incoming.operationId,
    );
  if (
    !isScopedRecordsDirectory(activeServerDir)
    && await hasMatchingLegacyOperationIdentity(
      activeServerDir,
      incoming.idempotencyKey,
    )
  ) {
    throw new ExternalSessionOperationRecordAdmissionError(
      'legacy_unavailable',
      incoming.operationId,
    );
  }
  await scanExternalSessionOperationRecordAdmission(
    scopedRecordsDirectory,
    incoming,
  );
}

export async function listExternalSessionOperationRecords(
  activeServerDir: string,
): Promise<readonly ExternalSessionOperationRecordV1[]> {
  if (!isScopedRecordsDirectory(activeServerDir)) {
    try {
      await stat(join(activeServerDir, 'external-session-operations'));
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) {
        // No durable operation root means there is no Account-partitioned
        // state to inspect. Once the root exists, scope resolution remains
        // mandatory before any retained operation can be read.
        return [];
      }
      throw new ExternalSessionOperationRecordReadError(
        'read_failed',
        'inventory',
        { cause: error },
      );
    }
  }
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      activeServerDir,
      'inventory',
    );
  const inventory = await readExternalSessionOperationRecordInventory(
    scopedRecordsDirectory,
    'inventory',
  );
  return inventory.flatMap(({ entry }) =>
    entry.kind === 'full_record' ? [entry.record] : []
  );
}

/**
 * Retire Account-private recovery state only from the durable Session-deletion
 * fact. Account-relative fetch absence is intentionally not an input to this
 * owner: share revocation and temporary access loss must retain recovery data.
 *
 * Once the authoritative parent-deletion fact exists, terminal status is no
 * longer preservation authority: the operation card, projection acknowledgement,
 * and every Session-scoped recovery control are unreachable, so retaining a
 * full record would keep private recovery data and inventory capacity forever.
 * Every matching full record — terminal or not — is therefore cleaned and
 * unlinked. Already-compacted terminal receipts carry no private recovery
 * state and stay on their bounded 24-hour expiry; they are never candidates
 * here because the inventory admits only full records.
 *
 * Claim barrier -> Session admission -> exact record -> staging capacity ->
 * inventory is the incumbent lock order used by passive repair. Cleanup is
 * deliberately before unlink so a crash can only leave an idempotently
 * retryable full record, never an unowned private payload.
 *
 * The caller must pin the Account scope whose authoritative changes feed
 * delivered the deletion fact. Ambient credential resolution is deliberately
 * unavailable here: an A→B rotation between the fact's delivery and its
 * consumption would otherwise silently consume the deletion against B's
 * partition and orphan A's private operation state forever. Unlike live
 * read/write paths, this retirement path therefore does not require the
 * ambient Account to match the pin — the fact itself proves ownership.
 */
export async function abandonExternalSessionOperationsForDeletedSession(
  input: Readonly<{
    activeServerDir: string;
    sessionId: string;
    /**
     * Pinned scope of the authenticated Account whose authoritative changes
     * feed delivered the Session-deletion fact. Required: without it exact
     * ownership cannot be established and the caller must fail closed.
     */
    accountScope: ExternalSessionOperationAccountScope;
    withSessionOperationBarrier<TResult>(
      input: Readonly<{ sessionId: string }>,
      effect: () => Promise<TResult>,
    ): Promise<
      | Readonly<{ status: 'active' }>
      | Readonly<{ status: 'executed'; value: TResult }>
    >;
    cleanupPrivateOperation(
      record: ExternalSessionOperationRecordV1,
    ): Promise<void>;
  }>,
): Promise<Readonly<{ deleted: number; deferred: number; retained: number }>> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error('external_session_operation_deleted_session_id_required');
  }
  if (
    !input.accountScope
    || input.accountScope.activeServerDir !== input.activeServerDir
  ) {
    throw new ExternalSessionOperationRecordReadError(
      'account_scope_unavailable',
      'session-deletion',
    );
  }
  // Deliberately not resolveExternalSessionOperationRecordsDirectory: that
  // owner enforces the ambient-credential match for live read/write paths,
  // which would defer this cleanup until the owning Account re-authenticates.
  // The deletion fact's provenance already establishes the owning partition.
  const scopedRecordsDirectory =
    recordsDirectoryForAccountScope(input.accountScope);
  const barrier = await input.withSessionOperationBarrier(
    { sessionId },
    async () => await withExternalSessionOperationSessionAdmissionLock(
      scopedRecordsDirectory,
      sessionId,
      async () => {
        const inventory = await readExternalSessionOperationRecordInventory(
          scopedRecordsDirectory,
          'session-deletion',
        );
        const candidates = inventory.flatMap(({ entry }) =>
          entry.kind === 'full_record'
          && entry.record.request.sessionId === sessionId
            ? [entry.record]
            : []
        );
        let deleted = 0;
        let retained = 0;
        for (const candidate of candidates) {
          const disposition = await withJsonOwnerFileLock({
            lockPath: recordMutationLockPath(
              scopedRecordsDirectory,
              candidate.operationId,
            ),
            timeoutMs: 5_000,
            staleAfterMs: 30_000,
            pollIntervalMs: 5,
            errorCode: 'external_session_operation_record_lock_timeout',
          }, async () => {
            const current = await readExternalSessionOperationStoredEntry(
              scopedRecordsDirectory,
              candidate.operationId,
            );
            if (
              !current
              || current.kind !== 'full_record'
              || current.record.request.sessionId !== sessionId
            ) {
              return 'retained' as const;
            }
            await input.cleanupPrivateOperation(current.record);
            return await withJsonOwnerFileLock({
              lockPath: inventoryAdmissionLockPath(scopedRecordsDirectory),
              timeoutMs: EXTERNAL_SESSION_OPERATION_INVENTORY_LOCK_TIMEOUT_MS,
              staleAfterMs: 30_000,
              pollIntervalMs: 5,
              errorCode:
                'external_session_operation_inventory_admission_lock_timeout',
            }, async () => {
              const exact = await readExternalSessionOperationStoredEntry(
                scopedRecordsDirectory,
                candidate.operationId,
              );
              if (
                !exact
                || exact.kind !== 'full_record'
                || exact.record.request.sessionId !== sessionId
              ) {
                return 'retained' as const;
              }
              await unlink(recordPath(
                scopedRecordsDirectory,
                candidate.operationId,
              ));
              return 'deleted' as const;
            });
          });
          if (disposition === 'deleted') deleted += 1;
          else retained += 1;
        }
        return Object.freeze({ deleted, retained });
      },
    ),
  );
  if (barrier.status === 'active') {
    return Object.freeze({ deleted: 0, deferred: 1, retained: 0 });
  }
  return Object.freeze({
    deleted: barrier.value.deleted,
    deferred: 0,
    retained: barrier.value.retained,
  });
}

export async function readExternalSessionOperationRecord(
  activeServerDir: string,
  operationId: string,
  accountScope?: ExternalSessionOperationAccountScope,
): Promise<ExternalSessionOperationRecordV1 | null> {
  const stored = await readExternalSessionOperationStoredEntry(
    activeServerDir,
    operationId,
    accountScope,
  );
  return stored?.kind === 'full_record' ? stored.record : null;
}

export async function readExternalSessionOperationStoredEntry(
  activeServerDir: string,
  operationId: string,
  accountScope?: ExternalSessionOperationAccountScope,
): Promise<ExternalSessionOperationStoredEntry | null> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      activeServerDir,
      operationId,
      accountScope,
    );
  let serialized: string;
  try {
    serialized = await readFile(
      recordPath(scopedRecordsDirectory, operationId),
      'utf8',
    );
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      if (
        !isScopedRecordsDirectory(activeServerDir)
        && await hasLegacyOperationId(activeServerDir, operationId)
      ) {
        throw new ExternalSessionOperationRecordReadError(
          'legacy_unscoped',
          operationId,
        );
      }
      return null;
    }
    throw new ExternalSessionOperationRecordReadError(
      'read_failed',
      operationId,
      { cause: error },
    );
  }

  return parseExternalSessionOperationStoredEntry(
    serialized,
    operationId,
    operationId,
  );
}

type ExternalSessionOperationStartIntent =
  | ExternalSessionOperationSemanticRequestV1
  | ExternalSessionMaterializeStartInputV1['request']
  | ExternalSessionTakeoverStartInputV1['request'];

export function projectExternalSessionTakeoverIdempotencyIntent(
  request: Extract<ExternalSessionOperationStartIntent, { plan: 'takeover' }>,
): ExternalSessionTakeoverStartInputV1['request'] {
  return {
    v: request.v,
    idempotencyKey: request.idempotencyKey,
    sessionId: request.sessionId,
    source: {
      machineId: request.source.machineId,
      remoteSessionId: request.source.remoteSessionId,
      qualifiedIdentity: request.source.qualifiedIdentity,
      linkGeneration: request.source.linkGeneration,
    },
    plan: request.plan,
    targetStorageMode: request.targetStorageMode,
    targetDirectory: request.targetDirectory,
    targetRuntimeMode: request.targetRuntimeMode,
  };
}

function idempotencyIntentDigestForRequest(
  request: ExternalSessionOperationStartIntent,
): string {
  const intent = request.plan === 'materialize'
    ? {
      v: request.v,
      sessionId: request.sessionId,
      plan: request.plan,
      targetStorageMode: request.targetStorageMode,
      targetRuntimeMode: request.targetRuntimeMode,
    }
    : projectExternalSessionTakeoverIdempotencyIntent(request);
  return createHash('sha256')
    .update(JSON.stringify(intent), 'utf8')
    .digest('hex');
}

function externalSessionOperationAuthorIntentJson(
  intent: ExternalSessionOperationAuthorIntentV1,
): string {
  return JSON.stringify(
    ExternalSessionOperationAuthorIntentV1Schema.parse(intent),
  );
}

function externalSessionOperationIntentEvidenceMatches(
  existing: Readonly<{
    authorIntent?: ExternalSessionOperationAuthorIntentV1;
    intentDigest: string;
  }>,
  incoming: Readonly<{
    authorIntent?: ExternalSessionOperationAuthorIntentV1;
    intentDigest?: string;
  }>,
): boolean {
  if (incoming.authorIntent) {
    return existing.authorIntent !== undefined
      && externalSessionOperationAuthorIntentJson(existing.authorIntent)
        === externalSessionOperationAuthorIntentJson(incoming.authorIntent);
  }
  return existing.authorIntent === undefined
    && incoming.intentDigest !== undefined
    && existing.intentDigest === incoming.intentDigest;
}

function externalSessionOperationCallerNamespaceMatches(
  existingAuthorIntent: ExternalSessionOperationAuthorIntentV1 | undefined,
  incomingAuthorIntent: ExternalSessionOperationAuthorIntentV1 | undefined,
): boolean {
  return (existingAuthorIntent === undefined)
    === (incomingAuthorIntent === undefined);
}

type ExternalSessionOperationStartInventoryDecision = Readonly<
  | {
    kind: 'existing_record';
    record: ExternalSessionOperationRecordV1;
  }
  | {
    kind: 'terminal_receipt';
    receipt: ExternalSessionOperationTerminalReceiptV1;
  }
  | { kind: 'miss' }
  | { kind: 'conflict' }
  | { kind: 'legacy_unavailable' }
>;

export type ExternalSessionPluginOperationPreflightAdmission = Readonly<
  | {
    kind: 'existing_record';
    record: ExternalSessionOperationRecordV1;
  }
  | {
    kind: 'terminal_receipt';
    receipt: ExternalSessionOperationTerminalReceiptV1;
  }
  | { kind: 'miss' }
  | { kind: 'conflict' }
  | { kind: 'legacy_unavailable' }
>;

/**
 * Performs the contextual plugin lookup after its caller has authorized the
 * current linked source. Final capacity/session admission and creation remain owned by
 * resolveExternalSessionOperationStartAdmission + writeExternalSessionOperationRecord
 * once the current private Start request exists.
 */
export async function resolveExternalSessionPluginOperationPreflightAdmission(
  input: Readonly<{
    activeServerDir: string;
    accountScope?: ExternalSessionOperationAccountScope;
    durableIdempotencyKey: string;
    authorIntent: ExternalSessionOperationAuthorIntentV1;
    nowMs: number;
  }>,
): Promise<ExternalSessionPluginOperationPreflightAdmission> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      input.activeServerDir,
      'external-plugin-operation-preflight',
      input.accountScope,
    );
  const authorIntent = ExternalSessionOperationAuthorIntentV1Schema.parse(
    input.authorIntent,
  );
  if (
    !isScopedRecordsDirectory(input.activeServerDir)
    && await hasMatchingLegacyOperationIdentity(
      input.activeServerDir,
      input.durableIdempotencyKey,
    )
  ) {
    return { kind: 'legacy_unavailable' };
  }
  await mkdir(recordsDirectory(scopedRecordsDirectory), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: inventoryAdmissionLockPath(scopedRecordsDirectory),
    timeoutMs: EXTERNAL_SESSION_OPERATION_INVENTORY_LOCK_TIMEOUT_MS,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode:
      'external_session_operation_inventory_admission_lock_timeout',
  }, async () => {
    const inventory = await readExternalSessionOperationRecordInventory(
      scopedRecordsDirectory,
      'external-plugin-operation-preflight',
    );
    let matched:
      | ExternalSessionPluginOperationPreflightAdmission
      | undefined;
    for (const { entry } of inventory) {
      if (entry.kind === 'terminal_receipt') {
        const { receipt } = entry;
        if (
          receipt.durableIdempotencyKey !== input.durableIdempotencyKey
          || isExternalSessionOperationTerminalReceiptExpired(
            receipt,
            input.nowMs,
          )
        ) {
          continue;
        }
        if (receipt.authorIntent === undefined) {
          continue;
        }
        if (
          externalSessionOperationAuthorIntentJson(receipt.authorIntent)
            !== externalSessionOperationAuthorIntentJson(authorIntent)
          || matched !== undefined
        ) {
          return { kind: 'conflict' };
        }
        matched = { kind: 'terminal_receipt', receipt };
        continue;
      }
      const { record } = entry;
      if (record.request.idempotencyKey !== input.durableIdempotencyKey) {
        continue;
      }
      if (record.authorIntent === undefined) {
        continue;
      }
      if (
        externalSessionOperationAuthorIntentJson(record.authorIntent)
          !== externalSessionOperationAuthorIntentJson(authorIntent)
        || matched !== undefined
      ) {
        return { kind: 'conflict' };
      }
      matched = { kind: 'existing_record', record };
    }
    return matched ?? { kind: 'miss' };
  });
}

type ExternalSessionOperationStartInventoryInspection = Readonly<{
  decision: ExternalSessionOperationStartInventoryDecision;
  expiredReceipts: readonly ExternalSessionOperationTerminalReceiptV1[];
  physicalInventorySize: number;
}>;

function inspectExternalSessionOperationStartInventory(
  inventory: readonly ExternalSessionOperationInventoryEntry[],
  input: Readonly<{
    durableIdempotencyKey: string;
    intent: ExternalSessionOperationStartIntent;
    intentDigest: string;
    authorIntent?: ExternalSessionOperationAuthorIntentV1;
    nowMs: number;
  }>,
): ExternalSessionOperationStartInventoryInspection {
  let matchedRecord: ExternalSessionOperationRecordV1 | undefined;
  let matchedReceipt:
    ExternalSessionOperationTerminalReceiptV1 | undefined;
  const expiredReceipts: ExternalSessionOperationTerminalReceiptV1[] = [];
  let conflicting = false;

  for (const { entry } of inventory) {
    if (entry.kind === 'terminal_receipt') {
      const { receipt } = entry;
      if (isExternalSessionOperationTerminalReceiptExpired(
        receipt,
        input.nowMs,
      )) {
        expiredReceipts.push(receipt);
        continue;
      }
      if (receipt.durableIdempotencyKey !== input.durableIdempotencyKey) {
        continue;
      }
      if (!externalSessionOperationCallerNamespaceMatches(
        receipt.authorIntent,
        input.authorIntent,
      )) {
        continue;
      }
      if (
        !externalSessionOperationIntentEvidenceMatches(
          {
            ...(receipt.authorIntent
              ? { authorIntent: receipt.authorIntent }
              : {}),
            intentDigest: receipt.idempotencyIntentDigest,
          },
          {
            ...(input.authorIntent
              ? { authorIntent: input.authorIntent }
              : {}),
            intentDigest: input.intentDigest,
          },
        )
        || matchedRecord !== undefined
        || matchedReceipt !== undefined
      ) {
        conflicting = true;
        continue;
      }
      matchedReceipt = receipt;
      continue;
    }

    const { record } = entry;
    if (
      record.request.idempotencyKey === input.durableIdempotencyKey
      && externalSessionOperationCallerNamespaceMatches(
        record.authorIntent,
        input.authorIntent,
      )
    ) {
      if (
        !externalSessionOperationIntentEvidenceMatches(
          {
            ...(record.authorIntent
              ? { authorIntent: record.authorIntent }
              : {}),
            intentDigest: idempotencyIntentDigestForRequest(record.request),
          },
          {
            ...(input.authorIntent
              ? { authorIntent: input.authorIntent }
              : {}),
            intentDigest: input.intentDigest,
          },
        )
        || matchedRecord !== undefined
        || matchedReceipt !== undefined
      ) {
        conflicting = true;
        continue;
      }
      matchedRecord = record;
      continue;
    }
    if (
      record.request.sessionId === input.intent.sessionId
      && !isExternalSessionOperationTerminalStatusV1(record.status)
    ) {
      conflicting = true;
    }
  }

  const decision: ExternalSessionOperationStartInventoryDecision = conflicting
    ? { kind: 'conflict' }
    : matchedRecord
      ? { kind: 'existing_record', record: matchedRecord }
      : matchedReceipt
        ? { kind: 'terminal_receipt', receipt: matchedReceipt }
        : { kind: 'miss' };
  return {
    decision,
    expiredReceipts,
    physicalInventorySize: inventory.length,
  };
}

function orderExpiredReceiptSessionIds(
  receipts: readonly ExternalSessionOperationTerminalReceiptV1[],
  incomingSessionId: string,
): readonly string[] {
  const sessionIds = new Set(receipts.map(
    (receipt) => receipt.reference.sessionId,
  ));
  const selected: string[] = [];
  if (sessionIds.delete(incomingSessionId)) {
    selected.push(incomingSessionId);
  }
  selected.push(...[...sessionIds].sort());
  return selected;
}

export type ExternalSessionOperationStartAdmission = Readonly<
  | {
    kind: 'existing_record';
    record: ExternalSessionOperationRecordV1;
  }
  | {
    kind: 'terminal_receipt';
    receipt: ExternalSessionOperationTerminalReceiptV1;
  }
  | {
    kind: 'new_operation';
    operationId: string;
  }
  | { kind: 'conflict' }
  | { kind: 'legacy_unavailable' }
>;

export async function resolveExternalSessionOperationStartAdmission(
  input: Readonly<{
    activeServerDir: string;
    durableIdempotencyKey: string;
    intent: ExternalSessionOperationStartIntent;
    authorIntent?: ExternalSessionOperationAuthorIntentV1;
    nowMs: number;
    readSelectedPresentation?:
      ExternalSessionOperationSelectedPresentationReader;
    /** Pinned authenticated Account scope from operation admission. */
    accountScope?: ExternalSessionOperationAccountScope;
  }>,
): Promise<ExternalSessionOperationStartAdmission> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      input.activeServerDir,
      `external-${input.intent.plan}:admission`,
      input.accountScope,
    );
  const intentDigest = idempotencyIntentDigestForRequest(input.intent);
  const admissionErrorOperationId =
    `external-${input.intent.plan}:admission`;
  if (
    !isScopedRecordsDirectory(input.activeServerDir)
    && await hasMatchingLegacyOperationIdentity(
      input.activeServerDir,
      input.durableIdempotencyKey,
    )
  ) {
    return { kind: 'legacy_unavailable' };
  }
  await mkdir(recordsDirectory(scopedRecordsDirectory), {
    recursive: true,
    mode: 0o700,
  });
  const inspectInventory = async () =>
    await withJsonOwnerFileLock({
      lockPath: inventoryAdmissionLockPath(scopedRecordsDirectory),
      timeoutMs: EXTERNAL_SESSION_OPERATION_INVENTORY_LOCK_TIMEOUT_MS,
      staleAfterMs: 30_000,
      pollIntervalMs: 5,
      errorCode:
        'external_session_operation_inventory_admission_lock_timeout',
    }, async () => {
      const inventory = await readExternalSessionOperationRecordInventory(
        scopedRecordsDirectory,
        admissionErrorOperationId,
      );
      return inspectExternalSessionOperationStartInventory(inventory, {
        durableIdempotencyKey: input.durableIdempotencyKey,
        intent: input.intent,
        intentDigest,
        ...(input.authorIntent
          ? {
              authorIntent: ExternalSessionOperationAuthorIntentV1Schema.parse(
                input.authorIntent,
              ),
            }
          : {}),
        nowMs: input.nowMs,
      });
    });

  let inspection = await inspectInventory();
  if (
    input.readSelectedPresentation
    && inspection.expiredReceipts.length > 0
  ) {
    const sessionIds = orderExpiredReceiptSessionIds(
      inspection.expiredReceipts,
      input.intent.sessionId,
    );
    const cleanupAtCapacity = inspection.decision.kind === 'miss'
      && inspection.physicalInventorySize
        >= MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY;
    let capacityFreed = 0;
    for (let offset = 0; offset < sessionIds.length; offset += 8) {
      const result =
        await pruneExpiredExternalSessionOperationTerminalReceiptCandidates({
          activeServerDir: scopedRecordsDirectory,
          nowMs: input.nowMs,
          sessionIds: sessionIds.slice(offset, offset + 8),
          receipts: inspection.expiredReceipts,
          readSelectedPresentation: input.readSelectedPresentation,
        });
      capacityFreed += result.capacityFreed;
      if (!cleanupAtCapacity) break;
      if (
        inspection.physicalInventorySize - capacityFreed
          < MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY
      ) {
        break;
      }
    }
    inspection = await inspectInventory();
  }

  if (inspection.decision.kind !== 'miss') {
    return inspection.decision;
  }
  if (
    inspection.physicalInventorySize
      >= MAX_EXTERNAL_SESSION_OPERATION_RECORD_INVENTORY
  ) {
    throw new ExternalSessionOperationRecordAdmissionError(
      'inventory_too_large',
      admissionErrorOperationId,
    );
  }
  return {
    kind: 'new_operation',
    operationId: `external-${input.intent.plan}:${randomUUID()}`,
  };
}

export function isExternalSessionOperationTerminalReceiptExpired(
  receipt: ExternalSessionOperationTerminalReceiptV1,
  nowMs: number,
): boolean {
  const parsed = ExternalSessionOperationTerminalReceiptV1Schema.parse(
    receipt,
  );
  return nowMs >= parsed.expiresAtMs;
}

export type ExternalSessionOperationTerminalReceiptCompactionResult = Readonly<
  | {
    status: 'compacted' | 'already_compacted';
    receipt: ExternalSessionOperationTerminalReceiptV1;
  }
  | {
    status: 'not_eligible';
    reason:
      | 'operation_not_found'
      | 'stale_revision'
      | 'operation_not_terminal'
      | 'recovery_action_required'
      | 'projection_unacknowledged'
      | 'staging_not_clean';
  }
>;

/**
 * A settled operation whose durable local side effects nothing can still need:
 * completed, cancelled, and discarded are the settled statuses, minus a
 * cancelled private materialization whose exact Discard transition is still
 * admitted. Its full record names either the local private capture or the
 * durable server-partial import state that Discard must release.
 *
 * This is the terminal cleanup and eventual receipt-compaction decision.
 * Projection acknowledgement and staging cleanup remain separate prerequisites
 * below, but no caller may invent another settled-status set.
 */
export function isExternalSessionOperationSettledForTerminalCleanup(
  record: ExternalSessionOperationRecordV1,
): boolean {
  return isExternalSessionOperationTerminalStatusV1(record.status)
    && record.terminalResult?.kind === record.status
    && !externalSessionOperationRetainsDiscardRecoveryV1(record);
}

/**
 * A receipt is safe once a terminal record has no actionable recovery work.
 * `isExternalSessionOperationSettledForTerminalCleanup` is the canonical
 * answer: it retains every cancelled record that exact Discard still admits
 * (local private capture or initial server partial), while allowing cleaned
 * non-actionable cancelled and discarded operations to use the existing
 * bounded receipt retention and inventory path.
 */
export function resolveExternalSessionOperationTerminalReceiptCompactionEligibility(
  record: ExternalSessionOperationRecordV1,
): 'eligible' | 'operation_not_terminal' | 'recovery_action_required' {
  if (
    !isExternalSessionOperationTerminalStatusV1(record.status)
    || record.terminalResult?.kind !== record.status
  ) {
    return 'operation_not_terminal';
  }
  return isExternalSessionOperationSettledForTerminalCleanup(record)
    ? 'eligible'
    : 'recovery_action_required';
}

export async function compactExternalSessionOperationRecordToTerminalReceipt(
  input: Readonly<{
    activeServerDir: string;
    operationId: string;
    expectedRevision: number;
    stagingDisposition:
      | 'not_applicable'
      | 'cleaned'
      | 'missing'
      | 'not_ready'
      | 'not_terminal';
    /** Pinned authenticated Account scope from operation admission. */
    accountScope?: ExternalSessionOperationAccountScope;
  }>,
): Promise<ExternalSessionOperationTerminalReceiptCompactionResult> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      input.activeServerDir,
      input.operationId,
      input.accountScope,
    );
  await mkdir(recordsDirectory(scopedRecordsDirectory), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: recordMutationLockPath(
      scopedRecordsDirectory,
      input.operationId,
    ),
    timeoutMs: 5_000,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode: 'external_session_operation_record_lock_timeout',
  }, async () => {
    const stored = await readExternalSessionOperationStoredEntry(
      scopedRecordsDirectory,
      input.operationId,
    );
    if (!stored) {
      return { status: 'not_eligible', reason: 'operation_not_found' };
    }
    if (stored.kind === 'terminal_receipt') {
      return stored.receipt.reference.revision === input.expectedRevision
        ? { status: 'already_compacted', receipt: stored.receipt }
        : { status: 'not_eligible', reason: 'stale_revision' };
    }
    const record = stored.record;
    if (record.revision !== input.expectedRevision) {
      return { status: 'not_eligible', reason: 'stale_revision' };
    }
    const compactionEligibility =
      resolveExternalSessionOperationTerminalReceiptCompactionEligibility(record);
    if (compactionEligibility !== 'eligible') {
      return { status: 'not_eligible', reason: compactionEligibility };
    }
    if (record.progressProjection.acknowledgedRevision !== record.revision) {
      return { status: 'not_eligible', reason: 'projection_unacknowledged' };
    }
    const stagingIsStructurallyAbsent = record.request.plan === 'takeover'
      && record.request.targetStorageMode === 'external-linked';
    const stagingIsClean = stagingIsStructurallyAbsent
      ? input.stagingDisposition === 'not_applicable'
      : input.stagingDisposition === 'cleaned'
        || input.stagingDisposition === 'missing';
    if (!stagingIsClean) {
      return { status: 'not_eligible', reason: 'staging_not_clean' };
    }
    const progress = projectExternalSessionOperationProgressV1(record);
    const reference: ExternalSessionOperationReferenceV1 =
      ExternalSessionOperationReferenceV1Schema.parse({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      });
    const presentation: ExternalSessionOperationSharedPresentationV1 =
      projectExternalSessionOperationSharedPresentationV1(progress);
    const receipt = ExternalSessionOperationTerminalReceiptV1Schema.parse({
      v: 1,
      recordKind: 'terminal_receipt',
      reference,
      presentation,
      durableIdempotencyKey: record.request.idempotencyKey,
      idempotencyIntentDigest: idempotencyIntentDigestForRequest(record.request),
      ...(record.authorIntent ? { authorIntent: record.authorIntent } : {}),
      terminalAtMs: record.updatedAtMs,
      expiresAtMs:
        record.updatedAtMs
        + EXTERNAL_SESSION_OPERATION_TERMINAL_RECEIPT_RETENTION_MS,
    });
    await writeJsonAtomic(
      recordPath(scopedRecordsDirectory, input.operationId),
      receipt,
    );
    return { status: 'compacted', receipt };
  });
}

export async function deleteExpiredExternalSessionOperationTerminalReceipt(
  input: Readonly<{
    activeServerDir: string;
    sessionId: string;
    operationId: string;
    expectedPresentation: ExternalSessionOperationSharedPresentationV1;
    expectedReceipt?: ExternalSessionOperationTerminalReceiptV1;
    nowMs: number;
    sessionAdmissionLockHeld?: boolean;
  }>,
): Promise<'deleted' | 'retained' | 'missing'> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      input.activeServerDir,
      input.operationId,
    );
  const deleteUnderSessionLock = async () =>
    await withJsonOwnerFileLock({
      lockPath: recordMutationLockPath(
        scopedRecordsDirectory,
        input.operationId,
      ),
      timeoutMs: 5_000,
      staleAfterMs: 30_000,
      pollIntervalMs: 5,
      errorCode: 'external_session_operation_record_lock_timeout',
    }, async () =>
      await withJsonOwnerFileLock({
        lockPath: inventoryAdmissionLockPath(scopedRecordsDirectory),
        timeoutMs: EXTERNAL_SESSION_OPERATION_INVENTORY_LOCK_TIMEOUT_MS,
        staleAfterMs: 30_000,
        pollIntervalMs: 5,
        errorCode:
          'external_session_operation_inventory_admission_lock_timeout',
      }, async () => {
        const stored = await readExternalSessionOperationStoredEntry(
          scopedRecordsDirectory,
          input.operationId,
        );
        if (!stored) return 'missing' as const;
        if (stored.kind !== 'terminal_receipt') return 'retained' as const;
        const { receipt } = stored;
        if (
          receipt.reference.sessionId !== input.sessionId
          || (
            input.expectedReceipt !== undefined
            && JSON.stringify(receipt)
              !== JSON.stringify(input.expectedReceipt)
          )
          || JSON.stringify(receipt.presentation)
            !== JSON.stringify(input.expectedPresentation)
          || !isExternalSessionOperationTerminalReceiptExpired(
            receipt,
            input.nowMs,
          )
        ) {
          return 'retained' as const;
        }
        await unlink(recordPath(scopedRecordsDirectory, input.operationId));
        return 'deleted' as const;
      }));

  if (input.sessionAdmissionLockHeld === true) {
    return await deleteUnderSessionLock();
  }
  return await withExternalSessionOperationSessionAdmissionLock(
    scopedRecordsDirectory,
    input.sessionId,
    deleteUnderSessionLock,
  );
}

async function pruneExpiredExternalSessionOperationTerminalReceiptCandidates(
  input: Readonly<{
    activeServerDir: string;
    nowMs: number;
    sessionIds: readonly string[];
    receipts: readonly ExternalSessionOperationTerminalReceiptV1[];
    readSelectedPresentation:
      ExternalSessionOperationSelectedPresentationReader;
    sessionAdmissionLockHeld?: boolean;
  }>,
): Promise<Readonly<{
  deleted: number;
  retained: number;
  capacityFreed: number;
}>> {
  const sessionIds = [...new Set(input.sessionIds)];
  if (sessionIds.length > 8) {
    throw new Error(
      'external_session_operation_receipt_prune_session_limit_exceeded',
    );
  }
  if (input.sessionAdmissionLockHeld === true && sessionIds.length !== 1) {
    throw new Error(
      'external_session_operation_receipt_prune_lock_scope_mismatch',
    );
  }

  let deleted = 0;
  let retained = 0;
  let capacityFreed = 0;
  for (const sessionId of sessionIds) {
    const candidates = input.receipts.filter(
      (receipt) => receipt.reference.sessionId === sessionId,
    );
    if (candidates.length === 0) continue;
    const pruneUnderSessionLock = async (): Promise<void> => {
      let selected: ExternalSessionOperationSelectedPresentationRead;
      try {
        selected = await input.readSelectedPresentation(sessionId);
      } catch {
        retained += candidates.length;
        return;
      }
      if (selected.kind === 'malformed') {
        retained += candidates.length;
        return;
      }
      for (const receipt of candidates) {
        if (
          selected.kind === 'valid'
          && JSON.stringify(selected.presentation)
            === JSON.stringify(receipt.presentation)
        ) {
          retained += 1;
          continue;
        }
        const disposition =
          await deleteExpiredExternalSessionOperationTerminalReceipt({
            activeServerDir: input.activeServerDir,
            sessionId,
            operationId: receipt.reference.operationId,
            expectedPresentation: receipt.presentation,
            expectedReceipt: receipt,
            nowMs: input.nowMs,
            sessionAdmissionLockHeld: true,
          });
        if (disposition === 'deleted') {
          deleted += 1;
          capacityFreed += 1;
        }
        if (disposition === 'missing') capacityFreed += 1;
        if (disposition === 'retained') retained += 1;
      }
    };
    if (input.sessionAdmissionLockHeld === true) {
      await pruneUnderSessionLock();
    } else {
      await withExternalSessionOperationSessionAdmissionLock(
        input.activeServerDir,
        sessionId,
        pruneUnderSessionLock,
      );
    }
  }
  return { deleted, retained, capacityFreed };
}

export async function pruneExpiredExternalSessionOperationTerminalReceipts(
  input: Readonly<{
    activeServerDir: string;
    nowMs: number;
    sessionIds: readonly string[];
    readSelectedPresentation:
      ExternalSessionOperationSelectedPresentationReader;
    sessionAdmissionLockHeld?: boolean;
  }>,
): Promise<Readonly<{ deleted: number; retained: number }>> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      input.activeServerDir,
      'receipt-prune',
    );
  const sessionIds = [...new Set(input.sessionIds)];
  if (sessionIds.length === 0) return { deleted: 0, retained: 0 };
  if (sessionIds.length > 8) {
    throw new Error(
      'external_session_operation_receipt_prune_session_limit_exceeded',
    );
  }
  const receipts = await withJsonOwnerFileLock({
    lockPath: inventoryAdmissionLockPath(scopedRecordsDirectory),
    timeoutMs: EXTERNAL_SESSION_OPERATION_INVENTORY_LOCK_TIMEOUT_MS,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode:
      'external_session_operation_inventory_admission_lock_timeout',
  }, async () => {
    const inventory = await readExternalSessionOperationRecordInventory(
      scopedRecordsDirectory,
      'receipt-prune',
    );
    const selectedSessionIds = new Set(sessionIds);
    return inventory.flatMap(({ entry }) =>
      entry.kind === 'terminal_receipt'
      && selectedSessionIds.has(entry.receipt.reference.sessionId)
      && isExternalSessionOperationTerminalReceiptExpired(
        entry.receipt,
        input.nowMs,
      )
        ? [entry.receipt]
        : []
    );
  });
  const result =
    await pruneExpiredExternalSessionOperationTerminalReceiptCandidates({
      ...input,
      activeServerDir: scopedRecordsDirectory,
      sessionIds,
      receipts,
    });
  return { deleted: result.deleted, retained: result.retained };
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
      priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
      priorTerminalReceiptEvidence:
        readonly ExternalSessionOperationPriorTerminalReceiptEvidence[],
    ) =>
      | ExternalSessionOperationSharedPresentationV1
      | undefined
      | Promise<ExternalSessionOperationSharedPresentationV1 | undefined>;
    settlePriorTerminalProgressProjection?: (
      priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
      incoming: ExternalSessionOperationRecordV1,
    ) => void | Promise<void>;
    nowMs?: () => number;
    /** Pinned authenticated Account scope from operation admission. */
    accountScope?: ExternalSessionOperationAccountScope;
  }> = {},
): Promise<ExternalSessionOperationRecordV1> {
  const parsed = ExternalSessionOperationRecordV1Schema.parse(record);
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      activeServerDir,
      parsed.operationId,
      options.accountScope,
    );
  if (
    !isScopedRecordsDirectory(activeServerDir)
    && await hasMatchingLegacyOperationIdentity(
      activeServerDir,
      parsed.request.idempotencyKey,
    )
  ) {
    throw new ExternalSessionOperationRecordAdmissionError(
      'legacy_unavailable',
      parsed.operationId,
    );
  }
  const path = recordPath(scopedRecordsDirectory, parsed.operationId);
  await mkdir(recordsDirectory(scopedRecordsDirectory), {
    recursive: true,
    mode: 0o700,
  });
  const writeUnderRecordLock = async (): Promise<ExternalSessionOperationRecordV1> => {
    return await withJsonOwnerFileLock({
      lockPath: recordMutationLockPath(
        scopedRecordsDirectory,
        parsed.operationId,
      ),
      timeoutMs: 5_000,
      staleAfterMs: 30_000,
      pollIntervalMs: 5,
      errorCode: 'external_session_operation_record_lock_timeout',
    }, async () => {
      const stored = await readExternalSessionOperationStoredEntry(
        scopedRecordsDirectory,
        parsed.operationId,
      );
      if (stored?.kind === 'terminal_receipt') {
        throw new ExternalSessionOperationRecordTransitionError(
          'compacted_record',
          parsed.operationId,
        );
      }
      const current = stored?.record ?? null;
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
        const priorTerminal =
          await scanExternalSessionOperationRecordAdmission(
          scopedRecordsDirectory,
          {
            sessionId: parsed.request.sessionId,
              operationId: parsed.operationId,
              idempotencyKey: parsed.request.idempotencyKey,
              intentDigest: idempotencyIntentDigestForRequest(parsed.request),
              ...(parsed.authorIntent
                ? { authorIntent: parsed.authorIntent }
                : {}),
              nowMs: options.nowMs?.(),
            },
          );
        if (priorTerminal.convergedRecord) {
          return priorTerminal.convergedRecord;
        }
        if (priorTerminal.convergedReceipt) {
          throw new ExternalSessionOperationRecordTransitionError(
            'compacted_record',
            priorTerminal.convergedReceipt.reference.operationId,
          );
        }
        await options.settlePriorTerminalProgressProjection?.(
          priorTerminal.priorTerminalRecords,
          parsed,
        );
        const settledPriorTerminal =
          await scanExternalSessionOperationRecordAdmission(
            scopedRecordsDirectory,
            {
              sessionId: parsed.request.sessionId,
              operationId: parsed.operationId,
              idempotencyKey: parsed.request.idempotencyKey,
              intentDigest: idempotencyIntentDigestForRequest(parsed.request),
              ...(parsed.authorIntent
                ? { authorIntent: parsed.authorIntent }
                : {}),
              nowMs: options.nowMs?.(),
            },
          );
        const selectedPriorTerminalPresentation =
          await options.validateSessionAdmission?.(
          current,
          parsed,
          settledPriorTerminal.priorTerminalRecords,
          settledPriorTerminal.priorTerminalReceiptEvidence,
        );
        const selectedPriorTerminalReceipt =
          settledPriorTerminal.priorTerminalReceiptEvidence.filter(
            (evidence) =>
              selectedPriorTerminalPresentation !== undefined
              && JSON.stringify(evidence.presentation)
                === JSON.stringify(selectedPriorTerminalPresentation),
          );
        if (selectedPriorTerminalReceipt.length > 1) {
          throw new ExternalSessionOperationRecordAdmissionError(
            'conflicting_operation',
            parsed.operationId,
          );
        }
        return await withJsonOwnerFileLock({
          lockPath: inventoryAdmissionLockPath(scopedRecordsDirectory),
          timeoutMs: EXTERNAL_SESSION_OPERATION_INVENTORY_LOCK_TIMEOUT_MS,
          staleAfterMs: 30_000,
          pollIntervalMs: 5,
          errorCode:
            'external_session_operation_inventory_admission_lock_timeout',
        }, async () => {
          const finalAdmission =
            await scanExternalSessionOperationRecordAdmission(
            scopedRecordsDirectory,
            {
              sessionId: parsed.request.sessionId,
              operationId: parsed.operationId,
              idempotencyKey: parsed.request.idempotencyKey,
              intentDigest: idempotencyIntentDigestForRequest(parsed.request),
              ...(parsed.authorIntent
                ? { authorIntent: parsed.authorIntent }
                : {}),
              nowMs: options.nowMs?.(),
            },
          );
          if (finalAdmission.convergedRecord) {
            return finalAdmission.convergedRecord;
          }
          if (finalAdmission.convergedReceipt) {
            throw new ExternalSessionOperationRecordTransitionError(
              'compacted_record',
              finalAdmission.convergedReceipt.reference.operationId,
            );
          }
          await writeJsonAtomic(path, parsed);
          return parsed;
        });
      }
      await options.validateSessionAdmission?.(current, parsed, [], []);
      if (current && updateDecision?.kind === 'duplicate') {
        return current;
      }
      await writeJsonAtomic(path, parsed);
      return parsed;
    });
  };
  return await withExternalSessionOperationSessionAdmissionLock(
    scopedRecordsDirectory,
    parsed.request.sessionId,
    writeUnderRecordLock,
    options.accountScope,
  );
}

export async function mutateExternalSessionOperationRecordAtRevision(
  activeServerDir: string,
  operationId: string,
  expectedRevision: number,
  mutate: (
    current: ExternalSessionOperationRecordV1,
  ) => ExternalSessionOperationRecordV1,
  accountScope?: ExternalSessionOperationAccountScope,
): Promise<
  | Readonly<{ ok: true; record: ExternalSessionOperationRecordV1 }>
  | Readonly<{ ok: false; code: 'operation_not_found' | 'stale_revision' }>
> {
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      activeServerDir,
      operationId,
      accountScope,
    );
  await mkdir(recordsDirectory(scopedRecordsDirectory), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: recordMutationLockPath(scopedRecordsDirectory, operationId),
    timeoutMs: 5_000,
    staleAfterMs: 30_000,
    pollIntervalMs: 5,
    errorCode: 'external_session_operation_record_lock_timeout',
  }, async () => {
    const current = await readExternalSessionOperationRecord(
      scopedRecordsDirectory,
      operationId,
    );
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
    await writeJsonAtomic(recordPath(scopedRecordsDirectory, operationId), next);
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
    /** Pinned authenticated Account scope from operation admission. */
    accountScope?: ExternalSessionOperationAccountScope;
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
  const scopedRecordsDirectory =
    await resolveExternalSessionOperationRecordsDirectory(
      input.activeServerDir,
      input.operationId,
      input.accountScope,
    );
  await mkdir(recordsDirectory(scopedRecordsDirectory), {
    recursive: true,
    mode: 0o700,
  });
  return await withJsonOwnerFileLock({
    lockPath: recordMutationLockPath(
      scopedRecordsDirectory,
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
        scopedRecordsDirectory,
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
      recordPath(scopedRecordsDirectory, input.operationId),
      acknowledged,
    );
    return acknowledged;
  });
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

import { replacePersonalHomeFileDurably } from './durableFile.js';
import { withPersonalHomeOperationAdmission, type PersonalHomeOperationAdmissionTarget } from './operationAdmission.js';
import { createPersonalHomePathProtection } from './protection.js';
import type { PersonalHomeAuthenticatedReadiness } from './readiness.js';
import { cleanupPersonalHomeRelocationUpload, hasPersonalHomeRelocationUploadReservation } from './relocationTransfer.js';

export type PersonalHomeRelocationDestinationStatus =
  | 'absent'
  | 'receiving'
  | 'staged'
  | 'quarantined'
  | 'activating'
  | 'active'
  | 'aborted'
  | 'recovery_required';

export type PersonalHomeRelocationDestinationFacts = Readonly<{
  operationId: string;
  status: Exclude<PersonalHomeRelocationDestinationStatus, 'absent'>;
  bundleSha256: string;
  expectedHomeServerIdentityId: string;
  expectedCanonicalServerUrl: string;
  sourceDescriptorRevision: number;
  homeServerIdentityId?: string;
  connectionDescriptor?: HomeConnectionDescriptorV1;
  authenticated?: true;
  accountCount?: number;
  sessionCount?: number;
  failureCode?: string;
  /** The destination-side transfer upload reservation could not be removed
   * after stage or abort. Destination authority remains valid. */
  transferCleanupNeedsAttention?: true;
  /** The activated Home is authoritative, but restore rollback artifacts could
   * not yet be finalized and require a later cleanup retry. */
  cleanupNeedsAttention?: true;
}>;

/** A destination holding no operation state. Abort also returns this shape when
 * the only remaining material was an exact upload reservation that it removed. */
export type PersonalHomeRelocationDestinationAbsence = Readonly<{
  operationId: string;
  status: 'absent';
  transferCleanupNeedsAttention?: true;
}>;

export type PersonalHomeRelocationDestinationStageInput = Readonly<{
  operationId: string;
  archivePath: string;
  bundleSha256: string;
  expectedHomeServerIdentityId: string;
  expectedCanonicalServerUrl: string;
  sourceDescriptorRevision: number;
  /** Attempt-scoped cancellation for reversible transfer/staging only. Cleanup,
   * status reconciliation, and commit deliberately use their own lifetimes. */
  signal?: AbortSignal;
}>;

export type PersonalHomeRelocationDestinationCommitInput = Readonly<{
  operationId: string;
  publishedDescriptor: HomeConnectionDescriptorV1;
}>;

export type PersonalHomeRelocationDestinationOwner = Readonly<{
  stage(input: PersonalHomeRelocationDestinationStageInput): Promise<PersonalHomeRelocationDestinationFacts>;
  status(operationId: string): Promise<PersonalHomeRelocationDestinationFacts | PersonalHomeRelocationDestinationAbsence>;
  commit(input: PersonalHomeRelocationDestinationCommitInput): Promise<PersonalHomeRelocationDestinationFacts>;
  abort(operationId: string): Promise<PersonalHomeRelocationDestinationFacts | PersonalHomeRelocationDestinationAbsence>;
}>;

/**
 * Durable proof that the destination bytes are this relocation's own candidate:
 * the canonical restore completed and its Home identity, authentication and
 * promoted Account/Session counts were verified against the reserved bundle.
 *
 * Anything weaker — a `receiving` marker, or a `recovery_required` marker whose
 * stage never produced verified facts — may be untouched pre-existing Home data
 * that this relocation never owned, and must never be erased.
 */
export function personalHomeRelocationDestinationOwnsCandidate(
  facts: PersonalHomeRelocationDestinationFacts,
): boolean {
  const { accountCount, sessionCount } = facts;
  return facts.authenticated === true
    && facts.homeServerIdentityId === facts.expectedHomeServerIdentityId
    && typeof accountCount === 'number' && Number.isSafeInteger(accountCount) && accountCount >= 1
    && typeof sessionCount === 'number' && Number.isSafeInteger(sessionCount) && sessionCount >= 0;
}

export function personalHomeRelocationDescriptorMatchesDestination(
  descriptor: HomeConnectionDescriptorV1 | null,
  destination: PersonalHomeRelocationDestinationFacts,
): boolean {
  return Boolean(descriptor && destination.connectionDescriptor
    && descriptor.homeServerIdentityId === destination.expectedHomeServerIdentityId
    && descriptor.revision > destination.sourceDescriptorRevision
    && JSON.stringify(descriptor) === JSON.stringify(destination.connectionDescriptor));
}

export class PersonalHomeRelocationDestinationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_relocation_operation'
      | 'relocation_operation_conflict'
      | 'relocation_bundle_mismatch'
      | 'relocation_destination_not_quarantined'
      | 'relocation_destination_recovery_required'
      | 'relocation_destination_not_staged'
      | 'relocation_destination_already_active',
    message: string,
  ) {
    super(message);
    this.name = 'PersonalHomeRelocationDestinationError';
  }
}

type Marker = PersonalHomeRelocationDestinationFacts & Readonly<{ version: 1 }>;

export type PersonalHomeRelocationDestinationStagedCandidate = Readonly<{
  authenticated: true;
  homeServerIdentityId: string;
  accountCount: number;
  sessionCount: number;
  connectionDescriptor: HomeConnectionDescriptorV1;
}>;

/** Outcome of inspecting the candidate left behind when a destination process
 * died between the durable `receiving` marker and the durable `staged` marker. */
export type PersonalHomeRelocationDestinationReceivedCandidate =
  /** Nothing was mutated: the canonical restore may run normally. */
  | Readonly<{ outcome: 'absent' }>
  /** The canonical restore already completed and its facts verify. */
  | (Readonly<{ outcome: 'restored' }> & PersonalHomeRelocationDestinationStagedCandidate)
  /** Partial or unverifiable candidate: artifacts are retained for explicit recovery. */
  | Readonly<{ outcome: 'ambiguous'; reason: string }>;

export type PersonalHomeRelocationDestinationDeps = Readonly<{
  dataDir: string;
  readValidatedTarget(): Promise<PersonalHomeOperationAdmissionTarget>;
  /** Verifies that an unreserved destination has no unrelated Home bytes.
   * Runs while the destination operation lock is held, before `absent` is
   * reported to the source as safe to reserve. */
  preflightDestination?(): Promise<void>;
  quarantine(): Promise<void>;
  readServiceStatus(): Promise<Readonly<{ running: boolean; quarantined: boolean }>>;
  /** Existing restore/verification owner. It must be retry-safe for this operation id. */
  stageCandidate(input: PersonalHomeRelocationDestinationStageInput): Promise<PersonalHomeRelocationDestinationStagedCandidate>;
  /** Reads the existing restore/identity/count/configuration/service facts of an
   * interrupted `receiving` candidate. It never re-restores or overwrites. */
  inspectReceivedCandidate(input: PersonalHomeRelocationDestinationStageInput): Promise<PersonalHomeRelocationDestinationReceivedCandidate>;
  activate(): Promise<void>;
  attestActive(): Promise<PersonalHomeAuthenticatedReadiness>;
  finalizeCandidate?(): Promise<void>;
  abortCandidate(operationId: string): Promise<void>;
  /** Whether the exact operation still reserves destination-side temporary
   * transfer material. Defaults to the shared relocation transfer owner. */
  hasUploadReservation?(operationId: string): Promise<boolean>;
  /** Removes the exact operation's temporary transfer reservation. Defaults to
   * the shared relocation transfer owner. */
  cleanupUploadReservation?(operationId: string): Promise<void>;
}>;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const markerPath = (dataDir: string): string => join(dataDir, '.operations', 'relocation-destination.json');
const protectRelocationDestinationPath = createPersonalHomePathProtection();

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) {
    throw new PersonalHomeRelocationDestinationError('invalid_relocation_operation', 'Invalid Personal Home relocation operation id.');
  }
}

function assertStageInput(input: PersonalHomeRelocationDestinationStageInput): void {
  assertOperationId(input.operationId);
  if (!input.archivePath.trim() || !SHA256.test(input.bundleSha256)
    || !input.expectedHomeServerIdentityId.trim()
    || !input.expectedCanonicalServerUrl.trim()
    || !Number.isSafeInteger(input.sourceDescriptorRevision) || input.sourceDescriptorRevision < 1) {
    throw new PersonalHomeRelocationDestinationError('invalid_relocation_operation', 'Invalid Personal Home relocation stage input.');
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function parseMarker(raw: string): Marker {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid marker');
  const value = parsed as Record<string, unknown>;
  const allowed = new Set(['version', 'operationId', 'status', 'bundleSha256', 'expectedHomeServerIdentityId', 'expectedCanonicalServerUrl', 'sourceDescriptorRevision', 'homeServerIdentityId', 'connectionDescriptor', 'authenticated', 'accountCount', 'sessionCount', 'failureCode', 'transferCleanupNeedsAttention', 'cleanupNeedsAttention']);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || value.version !== 1
    || typeof value.operationId !== 'string' || !OPERATION_ID.test(value.operationId)
    || typeof value.bundleSha256 !== 'string' || !SHA256.test(value.bundleSha256)
    || typeof value.expectedHomeServerIdentityId !== 'string' || !value.expectedHomeServerIdentityId
    || typeof value.expectedCanonicalServerUrl !== 'string' || !value.expectedCanonicalServerUrl
    || typeof value.sourceDescriptorRevision !== 'number' || !Number.isSafeInteger(value.sourceDescriptorRevision) || value.sourceDescriptorRevision < 1
    || typeof value.status !== 'string' || !['receiving', 'staged', 'quarantined', 'activating', 'active', 'aborted', 'recovery_required'].includes(value.status)
    || (value.homeServerIdentityId !== undefined && (typeof value.homeServerIdentityId !== 'string' || !value.homeServerIdentityId))
    || (value.authenticated !== undefined && value.authenticated !== true)
    || (value.accountCount !== undefined && (typeof value.accountCount !== 'number' || !Number.isSafeInteger(value.accountCount) || value.accountCount < 1))
    || (value.sessionCount !== undefined && (typeof value.sessionCount !== 'number' || !Number.isSafeInteger(value.sessionCount) || value.sessionCount < 0))
    || (value.failureCode !== undefined && (typeof value.failureCode !== 'string' || !value.failureCode))
    || (value.transferCleanupNeedsAttention !== undefined && value.transferCleanupNeedsAttention !== true)
    || (value.cleanupNeedsAttention !== undefined && value.cleanupNeedsAttention !== true)) {
    throw new Error('invalid marker');
  }
  if ((value.status === 'quarantined' || value.status === 'activating' || value.status === 'active')
    && (value.authenticated !== true || typeof value.accountCount !== 'number' || typeof value.sessionCount !== 'number')) {
    throw new Error('invalid marker');
  }
  const descriptor = value.connectionDescriptor === undefined ? undefined : HomeConnectionDescriptorV1Schema.parse(value.connectionDescriptor);
  if (descriptor && (descriptor.homeServerIdentityId !== value.expectedHomeServerIdentityId
    || descriptor.revision <= value.sourceDescriptorRevision)) throw new Error('invalid marker');
  if (['staged', 'quarantined', 'activating', 'active'].includes(value.status) && !descriptor) throw new Error('invalid marker');
  return {
    version: 1,
    operationId: value.operationId,
    status: value.status as Marker['status'],
    bundleSha256: value.bundleSha256,
    expectedHomeServerIdentityId: value.expectedHomeServerIdentityId,
    expectedCanonicalServerUrl: value.expectedCanonicalServerUrl,
    sourceDescriptorRevision: value.sourceDescriptorRevision,
    ...(value.homeServerIdentityId === undefined ? {} : { homeServerIdentityId: value.homeServerIdentityId as string }),
    ...(descriptor ? { connectionDescriptor: descriptor } : {}),
    ...(value.authenticated === true ? { authenticated: true as const } : {}),
    ...(typeof value.accountCount === 'number' ? { accountCount: value.accountCount } : {}),
    ...(typeof value.sessionCount === 'number' ? { sessionCount: value.sessionCount } : {}),
    ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode as string }),
    ...(value.transferCleanupNeedsAttention === true ? { transferCleanupNeedsAttention: true as const } : {}),
    ...(value.cleanupNeedsAttention === true ? { cleanupNeedsAttention: true as const } : {}),
  };
}

async function readMarker(dataDir: string): Promise<Marker | null> {
  try {
    return parseMarker(await readFile(markerPath(dataDir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PersonalHomeRelocationDestinationError(
      'relocation_destination_recovery_required',
      'Personal Home relocation destination state is invalid; activation remains blocked.',
    );
  }
}

/** The remote management carrier consumes the same strict facts as local recovery. */
export function parsePersonalHomeRelocationDestinationFacts(
  value: unknown,
  expectedOperationId: string,
): PersonalHomeRelocationDestinationFacts | PersonalHomeRelocationDestinationAbsence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid relocation destination facts');
  const record = value as Record<string, unknown>;
  if (record.operationId !== expectedOperationId || 'version' in record) throw new Error('Invalid relocation destination operation');
  if (record.status === 'absent') {
    if (Object.keys(record).some((key) => !['operationId', 'status', 'transferCleanupNeedsAttention'].includes(key))
      || (record.transferCleanupNeedsAttention !== undefined && record.transferCleanupNeedsAttention !== true)) {
      throw new Error('Invalid absent relocation destination facts');
    }
    return { operationId: expectedOperationId, status: 'absent',
      ...(record.transferCleanupNeedsAttention === true ? { transferCleanupNeedsAttention: true } : {}) };
  }
  return publicFacts(parseMarker(JSON.stringify({ ...record, version: 1 })));
}

export class PersonalHomeRelocationDestinationActivationBlockedError extends Error {
  readonly code = 'PERSONAL_HOME_RELOCATION_DESTINATION_ACTIVATION_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'PersonalHomeRelocationDestinationActivationBlockedError';
  }
}

export type PersonalHomeRelocationDestinationMaintenanceAdmission = Readonly<{
  operationId: string;
  action: 'attest' | 'materialize_endpoint';
}>;

/**
 * Exact operation-scoped admission for the two stopped server-light probes used
 * while the destination owner is building or recovering its candidate. This is
 * deliberately narrower than activation: callers cannot choose a bypass, and a
 * different operation id or a post-stage marker is rejected.
 */
export async function assertPersonalHomeRelocationDestinationAllowsMaintenance(
  dataDir: string,
  admission: PersonalHomeRelocationDestinationMaintenanceAdmission,
): Promise<void> {
  const operationId = admission.operationId.trim();
  if (!operationId) {
    throw new PersonalHomeRelocationDestinationActivationBlockedError(
      'Personal Home relocation maintenance requires an exact operation identity.',
    );
  }
  let marker: Marker | null;
  try {
    marker = await readMarker(dataDir);
  } catch (error) {
    throw new PersonalHomeRelocationDestinationActivationBlockedError(
      error instanceof Error ? error.message : 'Personal Home relocation destination state is unreadable.',
    );
  }
  if (!marker || marker.operationId !== operationId
    || (marker.status !== 'receiving' && marker.status !== 'recovery_required')) {
    throw new PersonalHomeRelocationDestinationActivationBlockedError(
      'Stopped Personal Home maintenance is not admitted for this relocation operation.',
    );
  }
}

/** Ordinary lifecycle admission. Only a destination whose publication has
 * already been validated by commit may be started; pre-publication candidates
 * remain stopped even when a caller invokes the generic runtime controls. */
export async function assertPersonalHomeRelocationDestinationAllowsActivation(dataDir: string): Promise<void> {
  let marker: Marker | null;
  try {
    marker = await readMarker(dataDir);
  } catch (error) {
    throw new PersonalHomeRelocationDestinationActivationBlockedError(
      error instanceof Error ? error.message : 'Personal Home relocation destination state is unreadable.',
    );
  }
  if (marker && marker.status !== 'aborted' && marker.status !== 'activating' && marker.status !== 'active') {
    throw new PersonalHomeRelocationDestinationActivationBlockedError(
      'This Personal Home is a staged relocation destination. Finish or abort the move before starting it.',
    );
  }
}

/** Only the exact destination operation may work on an uncommitted candidate. */
export async function assertPersonalHomeRelocationDestinationAllowsOperation(dataDir: string, operationId: string): Promise<void> {
  const marker = await readMarker(dataDir);
  if (!marker || marker.operationId === operationId || marker.status === 'aborted') return;
  throw new PersonalHomeRelocationDestinationActivationBlockedError('Another Personal Home relocation operation owns this destination.');
}

async function writeMarker(dataDir: string, marker: Marker): Promise<void> {
  const path = markerPath(dataDir);
  await mkdir(join(dataDir, '.operations'), { recursive: true, mode: 0o700 });
  await protectRelocationDestinationPath(join(dataDir, '.operations'), 'directory');
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    await protectRelocationDestinationPath(temporary, 'file');
    await replacePersonalHomeFileDurably(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function publicFacts(marker: Marker): PersonalHomeRelocationDestinationFacts {
  const { version: _version, ...facts } = marker;
  return facts;
}

function assertSameOperation(marker: Marker, operationId: string): void {
  if (marker.operationId !== operationId) {
    throw new PersonalHomeRelocationDestinationError(
      'relocation_operation_conflict',
      'Another Personal Home relocation operation already owns this destination.',
    );
  }
}

function markerForStage(input: PersonalHomeRelocationDestinationStageInput, status: Marker['status']): Marker {
  return {
    version: 1,
    operationId: input.operationId,
    status,
    bundleSha256: input.bundleSha256,
    expectedHomeServerIdentityId: input.expectedHomeServerIdentityId,
    expectedCanonicalServerUrl: input.expectedCanonicalServerUrl,
    sourceDescriptorRevision: input.sourceDescriptorRevision,
  };
}

async function resumeReceivedCandidate(
  deps: PersonalHomeRelocationDestinationDeps,
  input: PersonalHomeRelocationDestinationStageInput,
): Promise<PersonalHomeRelocationDestinationStagedCandidate> {
  if (await sha256File(input.archivePath) !== input.bundleSha256) {
    throw new PersonalHomeRelocationDestinationError('relocation_bundle_mismatch', 'Transferred Personal Home bundle digest does not match the source receipt.');
  }
  const received = await deps.inspectReceivedCandidate(input);
  if (received.outcome === 'restored') {
    const { outcome: _outcome, ...candidate } = received;
    return candidate;
  }
  if (received.outcome === 'absent') {
    return await deps.stageCandidate(input);
  }
  throw new PersonalHomeRelocationDestinationError(
    'relocation_destination_recovery_required',
    `The interrupted relocation destination candidate could not be verified: ${received.reason}`,
  );
}

export function createPersonalHomeRelocationDestinationOwner(deps: PersonalHomeRelocationDestinationDeps): PersonalHomeRelocationDestinationOwner {
  const withAdmission = <T>(operationId: string, operation: () => Promise<T>) => withPersonalHomeOperationAdmission({
    request: { kind: 'relocate', role: 'destination', operationId },
    readValidatedTarget: async () => {
      const target = await deps.readValidatedTarget();
      if (target.layout.dataDir !== deps.dataDir) throw new PersonalHomeRelocationDestinationError('relocation_operation_conflict', 'Personal Home destination layout changed before admission.');
      return target;
    },
    isHomeRunning: async () => (await deps.readServiceStatus()).running,
  }, operation);
  const hasUploadReservation = deps.hasUploadReservation
    ?? (async (operationId: string) => await hasPersonalHomeRelocationUploadReservation({ operationId }));
  const cleanupUploadReservation = deps.cleanupUploadReservation
    ?? (async (operationId: string) => {
      await cleanupPersonalHomeRelocationUpload({ operationId });
    });
  const removeReservationForAbort = async (operationId: string): Promise<Readonly<{ transferCleanupNeedsAttention?: true }>> => {
    try {
      await cleanupUploadReservation(operationId);
      return {};
    } catch {
      // The candidate state is durably aborted; only the temporary reservation
      // removal failed, and it is reported instead of failing the abort.
      return { transferCleanupNeedsAttention: true };
    }
  };
  const statusWithLease = async (operationId: string): Promise<PersonalHomeRelocationDestinationFacts | PersonalHomeRelocationDestinationAbsence> => {
    assertOperationId(operationId);
    const marker = await readMarker(deps.dataDir);
    if (!marker) {
      await deps.preflightDestination?.();
      return { operationId, status: 'absent' };
    }
    assertSameOperation(marker, operationId);
    return publicFacts(marker);
  };

  return Object.freeze({
    status: async (operationId) => await withAdmission(operationId, () => statusWithLease(operationId)),
    stage: async (input) => {
      assertStageInput(input);
      return await withAdmission(input.operationId, async () => {
        let existing = await readMarker(deps.dataDir);
        // An aborted candidate has relinquished destination authority. Keep it
        // visible and idempotent to its own operation, while treating it as
        // absence when a later distinct relocation is explicitly prepared.
        if (existing?.status === 'aborted' && existing.operationId !== input.operationId) {
          if (existing.transferCleanupNeedsAttention === true
            || await hasUploadReservation(existing.operationId)) {
            throw new PersonalHomeRelocationDestinationError(
              'relocation_operation_conflict',
              'The previous relocation destination still owns transfer cleanup that must be retried before another relocation.',
            );
          }
          existing = null;
        }
        if (existing) {
          assertSameOperation(existing, input.operationId);
          if (existing.bundleSha256 !== input.bundleSha256
            || existing.expectedHomeServerIdentityId !== input.expectedHomeServerIdentityId
            || existing.expectedCanonicalServerUrl !== input.expectedCanonicalServerUrl
            || existing.sourceDescriptorRevision !== input.sourceDescriptorRevision) {
            throw new PersonalHomeRelocationDestinationError('relocation_operation_conflict', 'Relocation retry facts differ from the reserved destination operation.');
          }
          if (existing.status === 'quarantined' || existing.status === 'active') return publicFacts(existing);
          if (existing.status === 'staged' && existing.homeServerIdentityId) {
            await deps.quarantine();
            const service = await deps.readServiceStatus();
            if (service.running || !service.quarantined) {
              throw new PersonalHomeRelocationDestinationError('relocation_destination_not_quarantined', 'Verified destination could not be left stopped and quarantined.');
            }
            const quarantined: Marker = { ...existing, status: 'quarantined' };
            await writeMarker(deps.dataDir, quarantined);
            return publicFacts(quarantined);
          }
          if (existing.status === 'aborted') {
            throw new PersonalHomeRelocationDestinationError('relocation_operation_conflict', 'The relocation destination operation was already aborted.');
          }
          if (existing.status === 'recovery_required') {
            throw new PersonalHomeRelocationDestinationError('relocation_destination_recovery_required', 'The relocation destination requires explicit recovery.');
          }
        }
        // A durable `receiving` marker means a previous process died inside the
        // canonical restore. The already-received candidate is reconciled from its
        // own facts rather than re-restored over a possibly non-empty destination.
        const resuming = existing?.status === 'receiving';
        if (!resuming) {
          if (!existing) await deps.preflightDestination?.();
          if (await sha256File(input.archivePath) !== input.bundleSha256) {
            throw new PersonalHomeRelocationDestinationError('relocation_bundle_mismatch', 'Transferred Personal Home bundle digest does not match the source receipt.');
          }
          if (!existing) {
            await writeMarker(deps.dataDir, markerForStage(input, 'receiving'));
          }
        }
        await deps.quarantine();
        const service = await deps.readServiceStatus();
        if (service.running || !service.quarantined) {
          throw new PersonalHomeRelocationDestinationError('relocation_destination_not_quarantined', 'Destination service is not durably stopped and quarantined.');
        }
        try {
          const candidate = resuming ? await resumeReceivedCandidate(deps, input) : await deps.stageCandidate(input);
          if (candidate.homeServerIdentityId !== input.expectedHomeServerIdentityId) {
            throw new PersonalHomeRelocationDestinationError('relocation_bundle_mismatch', 'Staged Personal Home identity does not match the relocation target.');
          }
          const descriptor = HomeConnectionDescriptorV1Schema.parse(candidate.connectionDescriptor);
          if (descriptor.homeServerIdentityId !== input.expectedHomeServerIdentityId
            || descriptor.revision <= input.sourceDescriptorRevision) {
            throw new PersonalHomeRelocationDestinationError('relocation_bundle_mismatch', 'Staged descriptor does not match the relocation target or source revision.');
          }
          if (candidate.authenticated !== true
            || !Number.isSafeInteger(candidate.accountCount) || candidate.accountCount < 1
            || !Number.isSafeInteger(candidate.sessionCount) || candidate.sessionCount < 0) {
            throw new PersonalHomeRelocationDestinationError('relocation_bundle_mismatch', 'Staged Personal Home authentication facts are invalid.');
          }
          const staged: Marker = {
            ...markerForStage(input, 'staged'),
            homeServerIdentityId: candidate.homeServerIdentityId,
            authenticated: true,
            accountCount: candidate.accountCount,
            sessionCount: candidate.sessionCount,
            connectionDescriptor: descriptor,
          };
          await writeMarker(deps.dataDir, staged);
          await deps.quarantine();
          const quarantinedStatus = await deps.readServiceStatus();
          if (quarantinedStatus.running || !quarantinedStatus.quarantined) {
            throw new PersonalHomeRelocationDestinationError('relocation_destination_not_quarantined', 'Verified destination could not be left stopped and quarantined.');
          }
          const quarantined: Marker = { ...staged, status: 'quarantined' };
          await writeMarker(deps.dataDir, quarantined);
          return publicFacts(quarantined);
        } catch (error) {
          await deps.quarantine().catch(() => undefined);
          const recovery: Marker = {
            ...markerForStage(input, 'recovery_required'),
            failureCode: error instanceof PersonalHomeRelocationDestinationError ? error.code : 'stage_failed',
          };
          await writeMarker(deps.dataDir, recovery).catch(() => undefined);
          throw error;
        }
      });
    },
    commit: async (input) => {
      assertOperationId(input.operationId);
      const publishedDescriptor = HomeConnectionDescriptorV1Schema.parse(input.publishedDescriptor);
      return await withAdmission(input.operationId, async () => {
        const marker = await readMarker(deps.dataDir);
        if (!marker) throw new PersonalHomeRelocationDestinationError('relocation_destination_not_staged', 'Relocation destination is not staged.');
        assertSameOperation(marker, input.operationId);
        if (!personalHomeRelocationDescriptorMatchesDestination(publishedDescriptor, marker)) {
          throw new PersonalHomeRelocationDestinationError('invalid_relocation_operation', 'Published destination descriptor does not match the staged Home endpoint facts or advance its revision.');
        }
        if (marker.status === 'active') {
          if (marker.cleanupNeedsAttention === true && deps.finalizeCandidate) {
            try {
              await deps.finalizeCandidate();
              const { cleanupNeedsAttention: _attention, ...cleaned } = marker;
              await writeMarker(deps.dataDir, cleaned);
              return publicFacts(cleaned);
            } catch {
              return publicFacts(marker);
            }
          }
          return publicFacts(marker);
        }
        if ((marker.status !== 'quarantined' && marker.status !== 'activating' && marker.status !== 'recovery_required') || !marker.homeServerIdentityId) {
          throw new PersonalHomeRelocationDestinationError('relocation_destination_not_staged', 'Relocation destination is not verified and quarantined.');
        }
        try {
          const { failureCode: _failureCode, ...verifiedMarker } = marker;
          const activating: Marker = { ...verifiedMarker, status: 'activating' };
          await writeMarker(deps.dataDir, activating);
          await deps.activate();
          const attestation = await deps.attestActive();
          if (!attestation.authenticated
            || attestation.homeServerIdentityId !== marker.homeServerIdentityId
            || attestation.accountCount !== marker.accountCount
            || attestation.sessionCount !== marker.sessionCount) {
            throw new PersonalHomeRelocationDestinationError(
              'relocation_destination_recovery_required',
              'Activated relocation destination identity or data counts do not match the staged Home.',
            );
          }
          const active: Marker = { ...activating, status: 'active' };
          await writeMarker(deps.dataDir, active);
          if (deps.finalizeCandidate) {
            try {
              await deps.finalizeCandidate();
            } catch {
              const attention: Marker = { ...active, cleanupNeedsAttention: true };
              await writeMarker(deps.dataDir, attention);
              return publicFacts(attention);
            }
          }
          return publicFacts(active);
        } catch (error) {
          await deps.quarantine().catch(() => undefined);
          const recovery: Marker = {
            ...marker,
            status: 'recovery_required',
            failureCode: error instanceof PersonalHomeRelocationDestinationError ? error.code : 'activation_failed',
          };
          await writeMarker(deps.dataDir, recovery).catch(() => undefined);
          throw error;
        }
      });
    },
    abort: async (operationId) => {
      assertOperationId(operationId);
      return await withAdmission(operationId, async () => {
        const marker = await readMarker(deps.dataDir);
        if (marker) assertSameOperation(marker, operationId);
        if (!marker) {
          // A transfer that failed before stage leaves an exact upload
          // reservation with no candidate marker. Abort owns its cleanup; an
          // operation with no reservation and no candidate is still not staged.
          if (!(await hasUploadReservation(operationId))) {
            throw new PersonalHomeRelocationDestinationError('relocation_destination_not_staged', 'Relocation destination is not staged.');
          }
          return {
            operationId,
            status: 'absent' as const,
            ...(await removeReservationForAbort(operationId)),
          };
        }
        if (marker.status === 'aborted') {
          // Retry the reservation removal so a previous cleanup failure converges.
          const cleanup = await removeReservationForAbort(operationId);
          if (cleanup.transferCleanupNeedsAttention === true) {
            const retained: Marker = { ...marker, transferCleanupNeedsAttention: true };
            await writeMarker(deps.dataDir, retained);
            return publicFacts(retained);
          }
          if (marker.transferCleanupNeedsAttention === true) {
            const { transferCleanupNeedsAttention: _attention, ...cleaned } = marker;
            await writeMarker(deps.dataDir, cleaned);
            return publicFacts(cleaned);
          }
          return publicFacts(marker);
        }
        if (marker.status === 'activating' || marker.status === 'active') {
          // Activation already ordered this Home into service, so it may hold
          // writes that exist nowhere else. Only the idempotent commit/readback
          // corridor may converge it; abort must never erase it.
          throw new PersonalHomeRelocationDestinationError(
            'relocation_destination_already_active',
            'The relocation destination has been activated; finish or recover the move instead of aborting it.',
          );
        }
        await deps.quarantine();
        const service = await deps.readServiceStatus();
        if (service.running || !service.quarantined) {
          throw new PersonalHomeRelocationDestinationError('relocation_destination_not_quarantined', 'Destination could not be quarantined before abort.');
        }
        if (!personalHomeRelocationDestinationOwnsCandidate(publicFacts(marker))) {
          // The destination cannot prove these bytes are this relocation's own
          // candidate, so they stay stopped and retained for explicit recovery
          // instead of being deleted. The original failure cause is preserved.
          const recovery: Marker = {
            ...marker,
            status: 'recovery_required',
            failureCode: marker.failureCode ?? 'destination_ownership_unproven',
          };
          await writeMarker(deps.dataDir, recovery);
          return publicFacts(recovery);
        }
        await deps.abortCandidate(operationId);
        const aborted: Marker = { ...marker, status: 'aborted' };
        await writeMarker(deps.dataDir, aborted);
        const cleanup = await removeReservationForAbort(operationId);
        if (cleanup.transferCleanupNeedsAttention === true) {
          const retained: Marker = { ...aborted, transferCleanupNeedsAttention: true };
          await writeMarker(deps.dataDir, retained);
          return publicFacts(retained);
        }
        return publicFacts(aborted);
      });
    },
  });
}

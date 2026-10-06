import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

import { replacePersonalHomeFileDurably } from './durableFile.js';
import { createPersonalHomePathProtection } from './protection.js';
import type {
  PersonalHomeRelocationDestinationFacts,
  PersonalHomeRelocationDestinationOwner,
} from './relocationDestination.js';
import {
  personalHomeRelocationDescriptorMatchesDestination,
  personalHomeRelocationDestinationOwnsCandidate,
} from './relocationDestination.js';

export type PersonalHomeRelocationSourceResult = Readonly<{
  operationId: string;
  status: 'committed' | 'pending' | 'returned';
  destinationMachineId: string;
  sourceDescriptorRevision: number;
  publishedDescriptor?: HomeConnectionDescriptorV1;
  recoveryAction?: 'finish_move' | 'return_to_source';
  destinationTransferCleanupNeedsAttention?: true;
  destinationCleanupNeedsAttention?: true;
  /**
   * The committed Home answers at a different public address than the source did.
   * Everything a third party registered against the old address — plugin webhooks,
   * OAuth callback URLs, public shares and previews, and any DNS/HTTPS or Iroh
   * record pointing at the old host — still points there and must be re-pointed.
   * Absent when the published address is unchanged and nothing needs re-pointing.
   */
  publicIntegrationsNeedAttention?: true;
}>;

export type PersonalHomeRelocationPublicationFacts = Readonly<{
  operationId: string;
  homeServerIdentityId: string;
  connectionDescriptor: HomeConnectionDescriptorV1;
}>;

export type PersonalHomeRelocationProgressStep =
  | 'preflight'
  | 'stopping_source'
  | 'creating_final_backup'
  | 'staging_destination'
  | 'quarantining_source'
  | 'returning_to_source'
  | 'publishing_destination'
  | 'finishing_move';

export type PersonalHomeRelocationSourceRecoveryFacts =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'ambiguous' }>
  | Readonly<{
      status: 'recovery_available';
      operationId: string;
      destinationMachineId: string;
      sourceDescriptorRevision: number;
      primaryAction: 'finish_move';
      /** Absent once publication moved writable authority to the destination:
       * returning would abort a Home that may already have accepted writes. */
      secondaryAction?: 'return_to_source';
    }>;

export type PersonalHomeRelocationSourceCoordinatorParams = Readonly<{
  sourceDataDir: string;
  operationId: string;
  homeServerIdentityId: string;
  sourceCanonicalServerUrl: string;
  sourceDescriptorRevision: number;
  destinationMachineId: string;
  signal?: AbortSignal;
  progress?(step: PersonalHomeRelocationProgressStep): void;
  recoveryAction?: 'finish_move' | 'return_to_source';
  /** Stops the source and reports whether it was in service beforehand. The
   * coordinator persists that fact, so recovery after a process restart never
   * depends on invocation-local state. */
  stopSource(): Promise<Readonly<{ wasRunning: boolean }>>;
  quarantineSource(): Promise<void>;
  activateSource(): Promise<void>;
  readSourceServiceStatus(): Promise<Readonly<{ running: boolean; quarantined: boolean }>>;
  createFinalBackup(): Promise<Readonly<{ archivePath: string; bundleSha256: string }>>;
  destination: PersonalHomeRelocationDestinationOwner;
  publishDestination(facts: PersonalHomeRelocationPublicationFacts): Promise<HomeConnectionDescriptorV1>;
  readPublishedDescriptor(homeServerIdentityId: string): Promise<HomeConnectionDescriptorV1 | null>;
}>;

export class PersonalHomeRelocationCancelledError extends Error {
  readonly code = 'operation_cancelled';

  constructor() {
    super('Personal Home relocation was cancelled before destination publication.');
    this.name = 'PersonalHomeRelocationCancelledError';
  }
}

type SourceMarker = Readonly<{
  version: 1;
  operationId: string;
  phase: 'preparing_source' | 'source_reserved' | 'destination_staged' | 'source_quarantined' | 'pending' | 'destination_published' | 'committed' | 'returning_to_source' | 'returned_to_source';
  destinationMachineId: string;
  bundleSha256?: string;
  /** Whether the source Home was in service when this relocation reserved it.
   * An automatic rollback restores exactly that state; an explicit return to
   * the original Home always puts it back in service. Older markers omit it and
   * are treated as previously running. */
  sourcePriorRunning?: boolean;
  /** Source-local archive reserved for this operation. It is required while the
   * destination has not accepted the bundle so a retry resumes the exact same
   * verified archive instead of producing a differently-digested one. */
  sourceArchivePath?: string;
  homeServerIdentityId: string;
  sourceCanonicalServerUrl: string;
  sourceDescriptorRevision: number;
  sourceDescriptor: HomeConnectionDescriptorV1;
  destinationTransferCleanupNeedsAttention?: true;
  destinationCleanupNeedsAttention?: true;
}>;

export class PersonalHomeRelocationSourceActivationBlockedError extends Error {
  readonly code = 'PERSONAL_HOME_RELOCATION_SOURCE_ACTIVATION_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'PersonalHomeRelocationSourceActivationBlockedError';
  }
}

/** A destination upload failed and the destination-local abort owner could not
 * prove that its operation-scoped plaintext transfer reservation was removed.
 * The transfer failure remains the primary error; this closed fact is carried
 * separately so the source coordinator can persist cleanup attention without
 * learning a destination filesystem path. */
export class PersonalHomeRelocationTransferCleanupError extends Error {
  readonly transferCleanupNeedsAttention = true as const;
  readonly cause: unknown;

  constructor(transferError: unknown) {
    const message = transferError instanceof Error && transferError.message.trim()
      ? transferError.message.trim()
      : 'Personal Home relocation archive transfer failed.';
    super(`${message} Destination transfer cleanup could not be confirmed and needs attention.`);
    this.name = 'PersonalHomeRelocationTransferCleanupError';
    this.cause = transferError;
  }
}

const protectRelocationSourcePath = createPersonalHomePathProtection();
const sourceMarkerPath = (dataDir: string): string => join(dataDir, '.operations', 'relocation-source.json');

function parseSourceMarker(raw: string): SourceMarker {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid marker');
  const marker = value as Record<string, unknown>;
  const sourceDescriptor = HomeConnectionDescriptorV1Schema.safeParse(marker.sourceDescriptor);
  if (Object.keys(marker).some((key) => !['version', 'operationId', 'phase', 'destinationMachineId', 'bundleSha256', 'sourceArchivePath', 'sourcePriorRunning', 'homeServerIdentityId', 'sourceCanonicalServerUrl', 'sourceDescriptorRevision', 'sourceDescriptor', 'destinationTransferCleanupNeedsAttention', 'destinationCleanupNeedsAttention'].includes(key))
    || marker.version !== 1
    || typeof marker.operationId !== 'string' || !marker.operationId
    || typeof marker.destinationMachineId !== 'string' || !marker.destinationMachineId
    || (marker.bundleSha256 !== undefined && (typeof marker.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(marker.bundleSha256)))
    || typeof marker.homeServerIdentityId !== 'string' || !marker.homeServerIdentityId
    || typeof marker.sourceCanonicalServerUrl !== 'string' || !marker.sourceCanonicalServerUrl
    || typeof marker.sourceDescriptorRevision !== 'number' || !Number.isSafeInteger(marker.sourceDescriptorRevision) || marker.sourceDescriptorRevision < 1
    || !sourceDescriptor.success
    || sourceDescriptor.data.homeServerIdentityId !== marker.homeServerIdentityId
    || sourceDescriptor.data.canonicalServerUrl !== marker.sourceCanonicalServerUrl
    || sourceDescriptor.data.revision !== marker.sourceDescriptorRevision
    || (marker.destinationTransferCleanupNeedsAttention !== undefined && marker.destinationTransferCleanupNeedsAttention !== true)
    || (marker.destinationCleanupNeedsAttention !== undefined && marker.destinationCleanupNeedsAttention !== true)
    || (marker.sourceArchivePath !== undefined && (typeof marker.sourceArchivePath !== 'string' || !isAbsolute(marker.sourceArchivePath)))
    || (marker.sourcePriorRunning !== undefined && typeof marker.sourcePriorRunning !== 'boolean')
    || typeof marker.phase !== 'string' || !['preparing_source', 'source_reserved', 'destination_staged', 'source_quarantined', 'pending', 'destination_published', 'committed', 'returning_to_source', 'returned_to_source'].includes(marker.phase)
    || (!['preparing_source', 'returning_to_source', 'returned_to_source'].includes(marker.phase) && typeof marker.bundleSha256 !== 'string')
    || (marker.phase === 'source_reserved' && typeof marker.sourceArchivePath !== 'string')) {
    throw new Error('invalid marker');
  }
  return marker as SourceMarker;
}

async function readSourceMarker(dataDir: string): Promise<SourceMarker | null> {
  try {
    return parseSourceMarker(await readFile(sourceMarkerPath(dataDir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Personal Home relocation source state is invalid; the source must remain quarantined.');
  }
}

/** Stable recovery projection for settings/CLI inspection. Internal phases and
 * source-local paths remain private to the coordinator. */
export async function inspectPersonalHomeRelocationSourceRecovery(
  dataDir: string,
): Promise<PersonalHomeRelocationSourceRecoveryFacts> {
  let marker: SourceMarker | null;
  try {
    marker = await readSourceMarker(dataDir);
  } catch {
    return { status: 'ambiguous' };
  }
  if (!marker || (marker.phase === 'committed' && marker.destinationCleanupNeedsAttention !== true)
    || (marker.phase === 'returned_to_source' && marker.destinationTransferCleanupNeedsAttention !== true)) {
    return { status: 'none' };
  }
  return {
    status: 'recovery_available',
    operationId: marker.operationId,
    destinationMachineId: marker.destinationMachineId,
    sourceDescriptorRevision: marker.sourceDescriptorRevision,
    primaryAction: 'finish_move',
    // Before publication is proven, Return to Original Home remains available:
    // its canonical coordinator path freshly verifies source authority before
    // aborting the staged destination. Published/committed phases can only finish.
    ...(['source_reserved', 'destination_staged', 'source_quarantined', 'pending'].includes(marker.phase)
      ? { secondaryAction: 'return_to_source' as const }
      : {}),
  };
}

/** Ordinary lifecycle/start paths consult the source-local authority marker.
 * Once the final stopped backup is reserved, the source must not accept writes
 * that are absent from that immutable bundle. Only the coordinator-owned
 * return-to-source corridor may reactivate it when restoring a running source.
 * Destination activation uses the distinct destination `commit` authority and
 * therefore never needs a caller-controlled bypass flag. */
export async function assertPersonalHomeRelocationSourceAllowsActivation(dataDir: string): Promise<void> {
  let marker: SourceMarker | null;
  try {
    marker = await readSourceMarker(dataDir);
  } catch (error) {
    throw new PersonalHomeRelocationSourceActivationBlockedError(
      error instanceof Error ? error.message : 'Personal Home relocation source state is unreadable.',
    );
  }
  if (marker && marker.phase !== 'returning_to_source' && marker.phase !== 'returned_to_source') {
    throw new PersonalHomeRelocationSourceActivationBlockedError(
      'This Personal Home is a stopped relocation source. Finish or recover the move before starting it.',
    );
  }
}

/** A completed move retains a stopped recovery copy. Explicit local administration can inspect,
 * back up, uninstall, or erase that copy without granting it writable activation authority. */
export async function assertPersonalHomeRelocationSourceAllowsAdministration(dataDir: string, isHomeRunning: () => Promise<boolean>): Promise<void> {
  const marker = await readSourceMarker(dataDir);
  if (marker?.phase === 'committed' && !await isHomeRunning()) return;
  await assertPersonalHomeRelocationSourceAllowsActivation(dataDir);
}

/** An existing source marker is resumable only by its exact relocation operation. */
export async function assertPersonalHomeRelocationSourceAllowsOperation(dataDir: string, operationId: string): Promise<void> {
  let marker: SourceMarker | null;
  try {
    marker = await readSourceMarker(dataDir);
  } catch (error) {
    throw new PersonalHomeRelocationSourceActivationBlockedError(
      error instanceof Error ? error.message : 'Personal Home relocation source state is unreadable.',
    );
  }
  if (marker && marker.operationId !== operationId
    && !(marker.phase === 'returned_to_source' && marker.destinationTransferCleanupNeedsAttention !== true)) {
    throw new PersonalHomeRelocationSourceActivationBlockedError('Another Personal Home relocation operation owns this source.');
  }
}

async function writeSourceMarker(dataDir: string, marker: SourceMarker): Promise<void> {
  const directory = join(dataDir, '.operations');
  const target = sourceMarkerPath(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await protectRelocationSourcePath(directory, 'directory');
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    await protectRelocationSourcePath(temporary, 'file');
    await replacePersonalHomeFileDurably(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertMarkerMatchesRequest(marker: SourceMarker, params: PersonalHomeRelocationSourceCoordinatorParams): void {
  if (marker.operationId !== params.operationId
    || marker.destinationMachineId !== params.destinationMachineId
    || marker.homeServerIdentityId !== params.homeServerIdentityId
    || marker.sourceCanonicalServerUrl !== params.sourceCanonicalServerUrl
    || marker.sourceDescriptorRevision !== params.sourceDescriptorRevision) {
    throw new Error('Another Personal Home relocation operation owns the source recovery state.');
  }
}

function descriptorMatchesDestination(
  descriptor: HomeConnectionDescriptorV1 | null,
  destination: PersonalHomeRelocationDestinationFacts,
): boolean {
  return personalHomeRelocationDescriptorMatchesDestination(descriptor, destination);
}

function descriptorMatchesSource(
  descriptor: HomeConnectionDescriptorV1,
  source: HomeConnectionDescriptorV1,
): boolean {
  return descriptor.homeServerIdentityId === source.homeServerIdentityId
    && descriptor.canonicalServerUrl === source.canonicalServerUrl
    && JSON.stringify(descriptor.endpoints) === JSON.stringify(source.endpoints)
    && descriptor.revision >= source.revision;
}

function destinationPublicationFacts(
  operationId: string,
  destination: PersonalHomeRelocationDestinationFacts,
): PersonalHomeRelocationPublicationFacts {
  if (!destination.homeServerIdentityId || !destination.connectionDescriptor) {
    throw new Error('Relocation destination did not provide a publishable connection endpoint.');
  }
  return {
    operationId,
    homeServerIdentityId: destination.homeServerIdentityId,
    connectionDescriptor: destination.connectionDescriptor,
  };
}

function cleanupAttentionFacts(marker: SourceMarker): Readonly<{
  destinationTransferCleanupNeedsAttention?: true;
  destinationCleanupNeedsAttention?: true;
}> {
  return {
    ...(marker.destinationTransferCleanupNeedsAttention === true ? { destinationTransferCleanupNeedsAttention: true as const } : {}),
    ...(marker.destinationCleanupNeedsAttention === true ? { destinationCleanupNeedsAttention: true as const } : {}),
  };
}

/**
 * The move only breaks outside registrations when the Home's published address
 * actually changed. Compare the committed descriptor against the marker's retained
 * source descriptor instead of assuming every move re-addresses the Home.
 */
function publicIntegrationFacts(
  marker: SourceMarker,
  published: HomeConnectionDescriptorV1,
): Readonly<{ publicIntegrationsNeedAttention?: true }> {
  const before = personalHomePublicAddresses(marker.sourceDescriptor);
  const after = personalHomePublicAddresses(published);
  const unchanged = before.length === after.length && before.every((address, index) => address === after[index]);
  return unchanged ? {} : { publicIntegrationsNeedAttention: true as const };
}

/**
 * Every value a third party could have registered: the canonical address plus each
 * published endpoint, key-sorted so field order in the descriptor never reads as a
 * changed address. Iroh endpoints are compared by their own fields, not by `kind`.
 */
function personalHomePublicAddresses(descriptor: HomeConnectionDescriptorV1): readonly string[] {
  const endpoints = descriptor.endpoints.map((endpoint) => Object.entries(endpoint)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join(';'));
  return [descriptor.canonicalServerUrl.trim(), ...endpoints].sort();
}

/** Both Homes stay stopped and intact; only the named recovery action is safe. */
function pendingRelocation(
  marker: SourceMarker,
  recoveryAction: 'finish_move' | 'return_to_source',
): PersonalHomeRelocationSourceResult {
  return {
    operationId: marker.operationId,
    status: 'pending',
    destinationMachineId: marker.destinationMachineId,
    sourceDescriptorRevision: marker.sourceDescriptorRevision,
    recoveryAction,
    ...cleanupAttentionFacts(marker),
  };
}

/**
 * Releases the source reservation once the destination has authoritatively
 * proven it holds no candidate. An explicit `Return to Original Home` always
 * puts the source back in service; an automatic rollback restores exactly the
 * service state the relocation found, read from the durable reservation fact.
 */
async function releaseReservationToSource(
  params: PersonalHomeRelocationSourceCoordinatorParams,
  marker: SourceMarker,
  intent: 'explicit_return' | 'automatic_rollback',
  failureMessage: string,
): Promise<void> {
  await writeSourceMarker(params.sourceDataDir, { ...marker, phase: 'returning_to_source' });
  if (intent === 'explicit_return' || marker.sourcePriorRunning !== false) {
    await params.activateSource();
    const sourceService = await params.readSourceServiceStatus();
    if (!sourceService.running || sourceService.quarantined) throw new Error(failureMessage);
  }
  await writeSourceMarker(params.sourceDataDir, { ...marker, phase: 'returned_to_source' });
}

function throwIfRelocationCancelled(params: PersonalHomeRelocationSourceCoordinatorParams): void {
  if (params.signal?.aborted) throw new PersonalHomeRelocationCancelledError();
}

async function returnStagedRelocationToSource(
  params: PersonalHomeRelocationSourceCoordinatorParams,
  marker: SourceMarker,
  intent: 'explicit_return' | 'automatic_rollback',
): Promise<PersonalHomeRelocationSourceResult> {
  const current = HomeConnectionDescriptorV1Schema.nullable().parse(
    await params.readPublishedDescriptor(params.homeServerIdentityId),
  );
  // A signal cannot prove that a concurrent/lost publication did not transfer
  // authority. In that case the existing Finish Moving recovery remains the
  // only truthful outcome.
  if (!current || !descriptorMatchesSource(current, marker.sourceDescriptor)) {
    return pendingRelocation(marker, 'finish_move');
  }
  const cleanup = await params.destination.abort(params.operationId);
  if (cleanup.transferCleanupNeedsAttention === true) {
    marker = { ...marker, destinationTransferCleanupNeedsAttention: true };
  } else {
    const { destinationTransferCleanupNeedsAttention: _attention, ...cleanedMarker } = marker;
    marker = cleanedMarker;
  }
  params.progress?.('returning_to_source');
  await releaseReservationToSource(
    params,
    marker,
    intent,
    'Original Personal Home authority remained published but its prior service state could not be restored.',
  );
  if (intent === 'automatic_rollback') throw new PersonalHomeRelocationCancelledError();
  return {
    operationId: params.operationId,
    status: 'returned',
    destinationMachineId: params.destinationMachineId,
    sourceDescriptorRevision: params.sourceDescriptorRevision,
    publishedDescriptor: current,
    ...cleanupAttentionFacts(marker),
  };
}

/**
 * Source-local cutover owner. The destination remains opaque: this coordinator
 * knows its stable machine identity and retry-safe operation contract, never a
 * remote filesystem path or service-manager command.
 */
export async function coordinatePersonalHomeRelocation(
  params: PersonalHomeRelocationSourceCoordinatorParams,
): Promise<PersonalHomeRelocationSourceResult> {
  let marker = await readSourceMarker(params.sourceDataDir);
  // Returning authority to the source completes the operation. Retain the
  // marker for same-operation retry/inspection, but it must not reserve the
  // source against a later, explicitly distinct relocation.
  if (marker?.phase === 'returned_to_source'
    && marker.destinationTransferCleanupNeedsAttention !== true
    && marker.operationId !== params.operationId) {
    marker = null;
  }
  if (marker?.phase === 'returned_to_source' && marker.destinationTransferCleanupNeedsAttention === true) {
    assertMarkerMatchesRequest(marker, params);
    const cleanup = await params.destination.abort(marker.operationId);
    if (cleanup.transferCleanupNeedsAttention === true) {
      return pendingRelocation(marker, 'return_to_source');
    }
    const { destinationTransferCleanupNeedsAttention: _attention, ...cleanedMarker } = marker;
    await writeSourceMarker(params.sourceDataDir, cleanedMarker);
    marker = cleanedMarker;
    const current = HomeConnectionDescriptorV1Schema.nullable().parse(
      await params.readPublishedDescriptor(params.homeServerIdentityId),
    );
    if (!current || !descriptorMatchesSource(current, marker.sourceDescriptor)) {
      throw new Error('Returned Personal Home source descriptor is no longer authoritative.');
    }
    return {
      operationId: marker.operationId,
      status: 'returned',
      destinationMachineId: marker.destinationMachineId,
      sourceDescriptorRevision: marker.sourceDescriptorRevision,
      publishedDescriptor: current,
    };
  }
  let createdReservation = false;
  let staged: PersonalHomeRelocationDestinationFacts;
  if (!marker) {
    params.progress?.('preflight');
    throwIfRelocationCancelled(params);
    const destinationPreflight = await params.destination.status(params.operationId);
    throwIfRelocationCancelled(params);
    if (destinationPreflight.status !== 'absent') {
      throw new Error('Relocation destination is not empty and available for this operation.');
    }
    const sourceDescriptor = HomeConnectionDescriptorV1Schema.nullable().parse(
      await params.readPublishedDescriptor(params.homeServerIdentityId),
    );
    throwIfRelocationCancelled(params);
    if (!sourceDescriptor
      || sourceDescriptor.homeServerIdentityId !== params.homeServerIdentityId
      || sourceDescriptor.canonicalServerUrl !== params.sourceCanonicalServerUrl
      || sourceDescriptor.revision !== params.sourceDescriptorRevision) {
      throw new Error('The current Personal Home source descriptor could not be authoritatively read before relocation.');
    }
    const sourceStatus = await params.readSourceServiceStatus();
    throwIfRelocationCancelled(params);
    marker = {
      version: 1,
      operationId: params.operationId,
      phase: 'preparing_source',
      destinationMachineId: params.destinationMachineId,
      sourcePriorRunning: sourceStatus.running,
      homeServerIdentityId: params.homeServerIdentityId,
      sourceCanonicalServerUrl: params.sourceCanonicalServerUrl,
      sourceDescriptorRevision: params.sourceDescriptorRevision,
      sourceDescriptor,
    };
    await writeSourceMarker(params.sourceDataDir, marker);
    try {
      throwIfRelocationCancelled(params);
      params.progress?.('stopping_source');
      const { wasRunning } = await params.stopSource();
      throwIfRelocationCancelled(params);
      if (wasRunning !== marker.sourcePriorRunning) {
        throw new Error('Personal Home source running state changed while relocation was preparing to stop it.');
      }
      params.progress?.('creating_final_backup');
      const backup = await params.createFinalBackup();
      throwIfRelocationCancelled(params);
      if (!isAbsolute(backup.archivePath) || !/^[a-f0-9]{64}$/u.test(backup.bundleSha256)) {
        throw new Error('Final Personal Home relocation backup did not return a valid source-local archive receipt.');
      }
      marker = {
        version: 1,
        operationId: params.operationId,
        phase: 'source_reserved',
        destinationMachineId: params.destinationMachineId,
        bundleSha256: backup.bundleSha256,
        sourceArchivePath: backup.archivePath,
        sourcePriorRunning: marker.sourcePriorRunning,
        homeServerIdentityId: params.homeServerIdentityId,
        sourceCanonicalServerUrl: params.sourceCanonicalServerUrl,
        sourceDescriptorRevision: params.sourceDescriptorRevision,
        sourceDescriptor,
      };
      await writeSourceMarker(params.sourceDataDir, marker);
      createdReservation = true;
    } catch (error) {
      await releaseReservationToSource(
        params,
        marker,
        'automatic_rollback',
        'Personal Home relocation preparation failed and the source could not be restored.',
      );
      throw error;
    }
  } else {
    assertMarkerMatchesRequest(marker, params);
  }

  if (marker.phase === 'preparing_source') {
    await releaseReservationToSource(
      params,
      marker,
      'automatic_rollback',
      'Interrupted Personal Home relocation preparation could not restore the source.',
    );
    throwIfRelocationCancelled(params);
    return {
      operationId: marker.operationId,
      status: 'returned',
      destinationMachineId: marker.destinationMachineId,
      sourceDescriptorRevision: marker.sourceDescriptorRevision,
      publishedDescriptor: marker.sourceDescriptor,
    };
  }

  let destinationStatus: Awaited<ReturnType<typeof params.destination.status>> = createdReservation
    ? { operationId: params.operationId, status: 'absent' }
    : await params.destination.status(params.operationId);
  let cancellationRequested = params.signal?.aborted === true;
  let returnRecovery = params.recoveryAction === 'return_to_source' || cancellationRequested;
  if (marker.phase === 'source_reserved') {
    if (returnRecovery && destinationStatus.status === 'absent') {
      const current = HomeConnectionDescriptorV1Schema.nullable().parse(
        await params.readPublishedDescriptor(params.homeServerIdentityId),
      );
      if (!current || !descriptorMatchesSource(current, marker.sourceDescriptor)) {
        return pendingRelocation(marker, 'return_to_source');
      }
      await releaseReservationToSource(
        params,
        marker,
        cancellationRequested ? 'automatic_rollback' : 'explicit_return',
        'Original Personal Home could not be reactivated after the destination authoritatively reported no staged candidate.',
      );
      if (cancellationRequested) throw new PersonalHomeRelocationCancelledError();
      return {
        operationId: params.operationId,
        status: 'returned',
        destinationMachineId: params.destinationMachineId,
        sourceDescriptorRevision: params.sourceDescriptorRevision,
        publishedDescriptor: current,
        ...cleanupAttentionFacts(marker),
      };
    }
    if (destinationStatus.status === 'recovery_required') {
      // The destination stopped before it could prove ownership of any candidate,
      // so neither Home may be activated, aborted, or erased from here.
      return pendingRelocation(marker, returnRecovery ? 'return_to_source' : 'finish_move');
    }
    if (destinationStatus.status !== 'absent'
      && destinationStatus.status !== 'receiving'
      && destinationStatus.status !== 'quarantined') {
      throw new Error('Reserved relocation destination state cannot be safely resumed.');
    }
    try {
      if (params.signal?.aborted) {
        cancellationRequested = true;
        returnRecovery = true;
      }
      if (returnRecovery && destinationStatus.status === 'absent') {
        await releaseReservationToSource(
          params,
          marker,
          params.recoveryAction === 'return_to_source' ? 'explicit_return' : 'automatic_rollback',
          'Original Personal Home could not be reactivated after cancellation before destination staging.',
        );
        if (cancellationRequested) throw new PersonalHomeRelocationCancelledError();
      }
      params.progress?.('staging_destination');
      staged = await params.destination.stage({
        operationId: params.operationId,
        archivePath: marker.sourceArchivePath!,
        bundleSha256: marker.bundleSha256!,
        expectedHomeServerIdentityId: params.homeServerIdentityId,
        expectedCanonicalServerUrl: params.sourceCanonicalServerUrl,
        sourceDescriptorRevision: params.sourceDescriptorRevision,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      if (error instanceof PersonalHomeRelocationTransferCleanupError) {
        marker = { ...marker, destinationTransferCleanupNeedsAttention: true };
        // The primary transfer error already carries cleanup attention. A
        // source-marker write failure must not replace it with a less useful
        // persistence exception; the source remains stopped either way.
        await writeSourceMarker(params.sourceDataDir, marker).catch(() => undefined);
      }
      try {
        destinationStatus = await params.destination.status(params.operationId);
      } catch {
        // The destination outcome is unknown. Keep the source stopped behind
        // its durable reservation until a later authoritative status read.
        throw error;
      }
      if (destinationStatus.status === 'absent') {
        await releaseReservationToSource(
          params,
          marker,
          'automatic_rollback',
          'Personal Home source could not be restored after the destination authoritatively reported no staged candidate.',
        );
        if (params.signal?.aborted) throw new PersonalHomeRelocationCancelledError();
      } else if (params.signal?.aborted) {
        return await returnStagedRelocationToSource(params, marker, 'automatic_rollback');
      }
      throw error;
    }
    if (staged.status !== 'quarantined'
      || staged.homeServerIdentityId !== params.homeServerIdentityId
      || staged.bundleSha256 !== marker.bundleSha256
      || staged.authenticated !== true) {
      throw new Error('Relocation destination did not return verified quarantined facts for the transferred Home.');
    }
    marker = {
      ...marker,
      phase: 'destination_staged',
      ...(staged.transferCleanupNeedsAttention === true ? { destinationTransferCleanupNeedsAttention: true as const } : {}),
    };
    await writeSourceMarker(params.sourceDataDir, marker);
    if (params.signal?.aborted) {
      cancellationRequested = true;
      returnRecovery = true;
    }
  } else {
    const recoveredDestinationStatus = destinationStatus;
    if (recoveredDestinationStatus.status === 'absent') {
      throw new Error('Relocation destination recovery state is not verified and quarantined.');
    }
    // A destination that failed after it had already restored, authenticated and
    // counted this relocation's own Home is still the verified candidate: its
    // commit is designed to be re-entered rather than abandoned.
    const verifiedRecoveryCandidate = recoveredDestinationStatus.status === 'recovery_required'
      && recoveredDestinationStatus.bundleSha256 === marker.bundleSha256
      && recoveredDestinationStatus.homeServerIdentityId === params.homeServerIdentityId
      && personalHomeRelocationDestinationOwnsCandidate(recoveredDestinationStatus);
    if (recoveredDestinationStatus.status === 'recovery_required' && !verifiedRecoveryCandidate) {
      return pendingRelocation(marker, returnRecovery ? 'return_to_source' : 'finish_move');
    }
    if (recoveredDestinationStatus.status !== 'quarantined'
      && recoveredDestinationStatus.status !== 'active'
      && !verifiedRecoveryCandidate
      && !(returnRecovery && recoveredDestinationStatus.status === 'aborted')) {
      throw new Error('Relocation destination recovery state is not verified and quarantined.');
    }
    staged = recoveredDestinationStatus;
    if (staged.status === 'active' || marker.phase === 'destination_published' || marker.phase === 'committed') {
      // Writable authority already moved to the destination. Only idempotent
      // publication readback and commit may converge; returning to the source
      // would abort a Home that may already have accepted writes.
      returnRecovery = false;
    }
    if (!returnRecovery && marker.phase === 'committed' && recoveredDestinationStatus.status === 'active') {
      const descriptor = await params.readPublishedDescriptor(params.homeServerIdentityId);
      if (!descriptor || !descriptorMatchesDestination(descriptor, staged)) {
        throw new Error('Committed relocation descriptor is no longer authoritative.');
      }
      if (marker.destinationCleanupNeedsAttention === true) {
        const recommittedDestination = await params.destination.commit({
          operationId: params.operationId,
          publishedDescriptor: descriptor,
        });
        if (recommittedDestination.cleanupNeedsAttention === true) {
          marker = { ...marker, destinationCleanupNeedsAttention: true };
        } else {
          const { destinationCleanupNeedsAttention: _attention, ...cleanedMarker } = marker;
          marker = cleanedMarker;
        }
        await writeSourceMarker(params.sourceDataDir, marker);
      }
      return {
        operationId: params.operationId,
        status: 'committed',
        destinationMachineId: params.destinationMachineId,
        sourceDescriptorRevision: params.sourceDescriptorRevision,
        publishedDescriptor: descriptor,
        ...cleanupAttentionFacts(marker),
        ...publicIntegrationFacts(marker, descriptor),
      };
    }
  }

  if (returnRecovery) {
    if (marker.phase === 'returned_to_source') {
      const current = HomeConnectionDescriptorV1Schema.nullable().parse(
        await params.readPublishedDescriptor(params.homeServerIdentityId),
      );
      if (!current || !descriptorMatchesSource(current, marker.sourceDescriptor)) {
        throw new Error('Returned Personal Home source descriptor is no longer authoritative.');
      }
      return {
        operationId: params.operationId,
        status: 'returned',
        destinationMachineId: params.destinationMachineId,
        sourceDescriptorRevision: params.sourceDescriptorRevision,
        publishedDescriptor: current,
        ...cleanupAttentionFacts(marker),
      };
    }
    return await returnStagedRelocationToSource(
      params,
      marker,
      cancellationRequested ? 'automatic_rollback' : 'explicit_return',
    );
  }

  if (marker.phase === 'destination_staged') {
    params.progress?.('quarantining_source');
    await params.quarantineSource();
    const sourceService = await params.readSourceServiceStatus();
    if (sourceService.running || !sourceService.quarantined) {
      throw new Error('Personal Home source could not be left stopped and quarantined for relocation cutover.');
    }
    marker = { ...marker, phase: 'source_quarantined' };
    await writeSourceMarker(params.sourceDataDir, marker);
    if (params.signal?.aborted) {
      return await returnStagedRelocationToSource(params, marker, 'automatic_rollback');
    }
  }

  // This progress transition closes the reversible UI window immediately
  // before invoking the external descriptor publisher. A signal delivered
  // after this point cannot establish whether publication committed.
  const publicationWasAlreadyDurable = marker.phase === 'destination_published'
    || marker.phase === 'committed'
    || staged.status === 'active';
  params.progress?.('publishing_destination');
  if (!publicationWasAlreadyDurable && params.signal?.aborted) {
    return await returnStagedRelocationToSource(params, marker, 'automatic_rollback');
  }
  try {
    HomeConnectionDescriptorV1Schema.parse(await params.publishDestination(
      destinationPublicationFacts(params.operationId, staged),
    ));
  } catch {
    // The publication request may have committed while its response was lost.
    // Fresh readback below is the sole authority for deciding whether cutover
    // may continue; neither Home is activated from a missing response.
  }
  const readback = HomeConnectionDescriptorV1Schema.nullable().parse(
    await params.readPublishedDescriptor(params.homeServerIdentityId),
  );
  const authoritative = descriptorMatchesDestination(readback, staged) ? readback : null;
  if (!authoritative) {
    marker = { ...marker, phase: 'pending' };
    await writeSourceMarker(params.sourceDataDir, marker);
    return pendingRelocation(marker, 'finish_move');
  }

  // Publication is the authority transfer point: from here the destination is
  // the published Home, so recovery may only finish the move.
  marker = { ...marker, phase: 'destination_published' };
  await writeSourceMarker(params.sourceDataDir, marker);
  params.progress?.('finishing_move');
  const committedDestination = await params.destination.commit({ operationId: params.operationId, publishedDescriptor: authoritative });
  marker = {
    ...marker,
    phase: 'committed',
    ...(committedDestination.cleanupNeedsAttention === true ? { destinationCleanupNeedsAttention: true as const } : {}),
  };
  await writeSourceMarker(params.sourceDataDir, marker);
  return {
    operationId: params.operationId,
    status: 'committed',
    destinationMachineId: params.destinationMachineId,
    sourceDescriptorRevision: params.sourceDescriptorRevision,
    publishedDescriptor: authoritative,
    ...cleanupAttentionFacts(marker),
    ...publicIntegrationFacts(marker, authoritative),
  };
}

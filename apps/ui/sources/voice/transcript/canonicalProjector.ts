import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  VoiceRealtimeStableIdSchema,
  VoiceTranscriptCanonicalEventV1Schema,
  type VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';
import { randomUUID } from '@/platform/randomUUID';

export type CanonicalVoiceTranscriptItem = Readonly<{
  epoch: number;
  attemptIdentity: string;
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  corrected: boolean;
  revision: number;
  firstSequence: number;
  lastSequence: number;
  provenance: 'live' | 'replay';
  announce: 'none' | 'polite';
}>;

export type CanonicalVoiceTranscriptAttempt = Readonly<{
  epoch: number;
  attemptIdentity: string;
}>;

export type CanonicalVoiceTranscriptDiagnostic = Readonly<{
  code: 'invalid_event' | 'stale_epoch' | 'future_epoch' | 'out_of_order' | 'conflicting_duplicate' | 'late_after_final' | 'correction_without_final';
  eventId: string | null;
  itemId: string | null;
}>;

export type CanonicalVoiceTranscriptProjectionResult = Readonly<{
  status: 'applied' | 'duplicate' | 'rejected';
  item: CanonicalVoiceTranscriptItem | null;
}>;

/**
 * Opaque custody for one exact persistence-producing event that passed canonical validation while
 * its attempt was current. It can be consumed once after an ordering barrier;
 * callers cannot substitute a different event or text at commit time.
 */
declare const canonicalVoiceTranscriptPersistenceAdmission: unique symbol;
export type CanonicalVoiceTranscriptPersistenceAdmission = Readonly<{
  readonly [canonicalVoiceTranscriptPersistenceAdmission]: true;
}>;

export type CanonicalVoiceTranscriptPersistenceCommit = Readonly<{
  item: CanonicalVoiceTranscriptItem;
  /** Whether this commit still belonged to the projector's current attempt. */
  appliedToCurrentSnapshot: boolean;
}>;

export function isCanonicalVoiceTranscriptPersistenceEvent(
  event: VoiceTranscriptCanonicalEventV1,
): event is Extract<VoiceTranscriptCanonicalEventV1, {
  type: 'voice.transcript.final' | 'voice.transcript.corrected';
}> {
  return event.type === 'voice.transcript.final'
    || event.type === 'voice.transcript.corrected';
}

function encodeOpaqueIdentityComponent(value: string): string {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
        encoded += encodeURIComponent(value.slice(index, index + 2));
        index += 1;
        continue;
      }
      encoded += `%u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      encoded += `%u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
      continue;
    }
    encoded += encodeURIComponent(value[index]!);
  }
  return encoded;
}

export function deriveCanonicalVoiceTranscriptEntryId(params: Readonly<{
  attemptIdentity: string;
  itemId: string;
  role: 'user' | 'assistant';
}>): string {
  return `voice-realtime:${encodeOpaqueIdentityComponent(params.attemptIdentity)}:${params.role}:${encodeOpaqueIdentityComponent(params.itemId)}`;
}

type CanonicalVoiceTranscriptProjectorDeps = Readonly<{
  maxItems?: number;
  maxDiagnostics?: number;
  persistFinal?: (item: CanonicalVoiceTranscriptItem) => void;
  onProjection?: (item: CanonicalVoiceTranscriptItem) => void;
  onDiagnostic?: (diagnostic: CanonicalVoiceTranscriptDiagnostic) => void;
  createAttemptIdentity?: () => string;
}>;

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.max(1, Math.floor(Number(value))) : fallback;
}

function eventFingerprint(event: VoiceTranscriptCanonicalEventV1): string {
  return JSON.stringify([
    event.type,
    event.epoch,
    event.sequence,
    event.revision,
    event.itemId,
    event.role,
    event.text,
  ]);
}

function eventFingerprintDigest(fingerprint: string): string {
  return bytesToHex(sha256(utf8ToBytes(fingerprint)));
}

export function createCanonicalVoiceTranscriptProjector(deps: CanonicalVoiceTranscriptProjectorDeps = {}) {
  const maxItems = clampPositiveInteger(deps.maxItems, 500);
  const maxDiagnostics = clampPositiveInteger(deps.maxDiagnostics, 64);
  const maxEventIds = Math.max(maxItems * 4, 128);
  const items = new Map<string, CanonicalVoiceTranscriptItem>();
  const seenEventIds = new Map<string, string>();
  const lastItemEventFingerprints = new Map<string, string>();
  type FinalizedItemMetadata = Readonly<{
    role: 'user' | 'assistant';
    revision: number;
    firstSequence: number;
    lastSequence: number;
    fingerprintDigest: string;
  }>;
  // One compact attempt-local authority record per finalized identity survives
  // snapshot eviction so a provider's later higher-revision correction can
  // still replace its final. It deliberately excludes transcript text and is
  // cleared with the attempt.
  const finalizedItemMetadata = new Map<string, FinalizedItemMetadata>();
  const eventIdOrder: string[] = [];
  type PendingAdmittedPersistenceEvent = {
    admission: CanonicalVoiceTranscriptPersistenceAdmission;
    eventId: string;
    fingerprint: string;
    item: CanonicalVoiceTranscriptItem;
    epoch: number;
    attemptIdentity: string;
    predecessor: PendingAdmittedPersistenceEvent | null;
    successor: PendingAdmittedPersistenceEvent | null;
    committed: boolean;
  };
  // Reservations affect validation only while their attempt remains current.
  // The opaque admission itself survives a newer attempt so its exact durable
  // persistence event can drain without restoring the retired attempt's snapshot/epoch.
  const admittedPersistenceEvents = new WeakMap<
    CanonicalVoiceTranscriptPersistenceAdmission,
    PendingAdmittedPersistenceEvent
  >();
  const pendingAdmittedPersistenceEventsByEventId = new Map<string, PendingAdmittedPersistenceEvent>();
  const pendingAdmittedPersistenceEventsByItemId = new Map<string, PendingAdmittedPersistenceEvent>();
  let epoch: number | null = null;
  let attemptIdentity: string | null = null;
  let lastLiveSequence = -1;
  let diagnosticCount = 0;
  const createAttemptIdentity = (): string => VoiceRealtimeStableIdSchema.parse(
    deps.createAttemptIdentity?.() ?? randomUUID(),
  );

  const diagnose = (
    code: CanonicalVoiceTranscriptDiagnostic['code'],
    event?: Partial<VoiceTranscriptCanonicalEventV1> | null,
  ): CanonicalVoiceTranscriptProjectionResult => {
    if (diagnosticCount < maxDiagnostics) {
      diagnosticCount += 1;
      deps.onDiagnostic?.({
        code,
        eventId: typeof event?.eventId === 'string' ? event.eventId : null,
        itemId: typeof event?.itemId === 'string' ? event.itemId : null,
      });
    }
    return { status: 'rejected', item: null };
  };

  const rememberEventId = (eventId: string, fingerprint: string): void => {
    seenEventIds.set(eventId, fingerprint);
    eventIdOrder.push(eventId);
    while (eventIdOrder.length > maxEventIds) {
      const retired = eventIdOrder.shift();
      if (retired) seenEventIds.delete(retired);
    }
  };

  const rememberFinalizedItem = (
    item: CanonicalVoiceTranscriptItem,
    fingerprint: string,
  ): void => {
    finalizedItemMetadata.delete(item.itemId);
    finalizedItemMetadata.set(item.itemId, Object.freeze({
      role: item.role,
      revision: item.revision,
      firstSequence: item.firstSequence,
      lastSequence: item.lastSequence,
      fingerprintDigest: eventFingerprintDigest(fingerprint),
    }));
  };

  const evictItems = (): void => {
    while (items.size > maxItems) {
      const oldest = [...items.values()].sort((left, right) => (
        left.firstSequence - right.firstSequence || left.itemId.localeCompare(right.itemId)
      ))[0];
      if (!oldest) return;
      items.delete(oldest.itemId);
      lastItemEventFingerprints.delete(oldest.itemId);
    }
  };

  const greatestReservedLiveSequence = (): number => {
    let greatest = -1;
    for (const pending of pendingAdmittedPersistenceEventsByEventId.values()) {
      if (pending.item.provenance === 'live') {
        greatest = Math.max(greatest, pending.item.lastSequence);
      }
    }
    return greatest;
  };

  const forgetPendingAdmission = (pending: PendingAdmittedPersistenceEvent): void => {
    if (pendingAdmittedPersistenceEventsByEventId.get(pending.eventId) === pending) {
      pendingAdmittedPersistenceEventsByEventId.delete(pending.eventId);
    }
    if (pendingAdmittedPersistenceEventsByItemId.get(pending.item.itemId) === pending) {
      const predecessor = pending.predecessor;
      if (
        predecessor
        && admittedPersistenceEvents.get(predecessor.admission) === predecessor
      ) {
        pendingAdmittedPersistenceEventsByItemId.set(pending.item.itemId, predecessor);
      } else {
        pendingAdmittedPersistenceEventsByItemId.delete(pending.item.itemId);
      }
    }
  };

  const releasePendingAdmissionChain = (first: PendingAdmittedPersistenceEvent): void => {
    const retainedPredecessor = (
      first.predecessor
      && admittedPersistenceEvents.get(first.predecessor.admission) === first.predecessor
    ) ? first.predecessor : null;
    const currentTail = pendingAdmittedPersistenceEventsByItemId.get(first.item.itemId) ?? null;
    let releasedCurrentTail = false;
    let pending: PendingAdmittedPersistenceEvent | null = first;
    while (pending) {
      const successor: PendingAdmittedPersistenceEvent | null = pending.successor;
      if (pending === currentTail) releasedCurrentTail = true;
      admittedPersistenceEvents.delete(pending.admission);
      if (pendingAdmittedPersistenceEventsByEventId.get(pending.eventId) === pending) {
        pendingAdmittedPersistenceEventsByEventId.delete(pending.eventId);
      }
      pending = successor;
    }
    if (!releasedCurrentTail) return;
    if (retainedPredecessor) {
      retainedPredecessor.successor = null;
      pendingAdmittedPersistenceEventsByItemId.set(first.item.itemId, retainedPredecessor);
    } else {
      pendingAdmittedPersistenceEventsByItemId.delete(first.item.itemId);
    }
  };

  const resetEpoch = (nextEpoch: number): boolean => {
    if (!Number.isInteger(nextEpoch) || nextEpoch < 0 || (epoch !== null && nextEpoch <= epoch)) return false;
    const nextAttemptIdentity = createAttemptIdentity();
    epoch = nextEpoch;
    attemptIdentity = nextAttemptIdentity;
    lastLiveSequence = -1;
    items.clear();
    seenEventIds.clear();
    lastItemEventFingerprints.clear();
    finalizedItemMetadata.clear();
    eventIdOrder.length = 0;
    pendingAdmittedPersistenceEventsByEventId.clear();
    pendingAdmittedPersistenceEventsByItemId.clear();
    diagnosticCount = 0;
    return true;
  };

  const beginAttempt = (): CanonicalVoiceTranscriptAttempt => {
    const nextEpoch = (epoch ?? 0) + 1;
    if (!resetEpoch(nextEpoch)) {
      throw new Error('voice_transcript_attempt_epoch_unavailable');
    }
    return Object.freeze({
      epoch: nextEpoch,
      attemptIdentity: attemptIdentity!,
    });
  };

  const project = (rawEvent: unknown): CanonicalVoiceTranscriptProjectionResult => {
    const parsed = VoiceTranscriptCanonicalEventV1Schema.safeParse(rawEvent);
    if (!parsed.success) return diagnose('invalid_event');
    const event = parsed.data;

    if (epoch === null) {
      epoch = event.epoch;
      attemptIdentity = createAttemptIdentity();
    }
    if (event.epoch < epoch) return diagnose('stale_epoch', event);
    if (event.epoch > epoch) return diagnose('future_epoch', event);
    const fingerprint = eventFingerprint(event);
    const pendingByEventId = pendingAdmittedPersistenceEventsByEventId.get(event.eventId);
    if (pendingByEventId) {
      return pendingByEventId.fingerprint === fingerprint
        ? { status: 'duplicate', item: null }
        : diagnose('conflicting_duplicate', event);
    }
    const seenFingerprint = seenEventIds.get(event.eventId);
    if (seenFingerprint !== undefined) {
      return seenFingerprint === fingerprint
        ? { status: 'duplicate', item: items.get(event.itemId) ?? null }
        : diagnose('conflicting_duplicate', event);
    }

    const previous = items.get(event.itemId) ?? null;
    const finalized = finalizedItemMetadata.get(event.itemId) ?? null;
    const pendingByItemId = pendingAdmittedPersistenceEventsByItemId.get(event.itemId);
    if (pendingByItemId) {
      return pendingByItemId.fingerprint === fingerprint
        ? { status: 'duplicate', item: null }
        : diagnose('late_after_final', event);
    }
    const previousRole = previous?.role ?? finalized?.role;
    if (previousRole && previousRole !== event.role) return diagnose('conflicting_duplicate', event);
    const lastItemFingerprint = lastItemEventFingerprints.get(event.itemId);
    if (
      lastItemFingerprint === fingerprint
      || (
        lastItemFingerprint === undefined
        && finalized?.fingerprintDigest === eventFingerprintDigest(fingerprint)
      )
    ) {
      rememberEventId(event.eventId, fingerprint);
      return { status: 'duplicate', item: previous };
    }
    if (
      event.provenance === 'live'
      && event.sequence <= Math.max(lastLiveSequence, greatestReservedLiveSequence())
    ) {
      return diagnose('out_of_order', event);
    }
    const isCorrection = event.type === 'voice.transcript.corrected';
    if (isCorrection && !finalized) return diagnose('correction_without_final', event);
    if (finalized && !isCorrection) return diagnose('late_after_final', event);
    const previousRevision = previous?.revision ?? finalized?.revision;
    if (previousRevision !== undefined && event.revision <= previousRevision) {
      return diagnose('conflicting_duplicate', event);
    }
    const previousLastSequence = previous?.lastSequence ?? finalized?.lastSequence;
    if (
      previousLastSequence !== undefined
      && event.provenance === 'live'
      && event.sequence <= previousLastSequence
    ) {
      return diagnose('out_of_order', event);
    }

    const next: CanonicalVoiceTranscriptItem = Object.freeze({
      epoch: event.epoch,
      attemptIdentity: attemptIdentity!,
      itemId: event.itemId,
      role: event.role,
      text: event.type === 'voice.transcript.delta' ? `${previous?.text ?? ''}${event.text}` : event.text,
      final: event.type === 'voice.transcript.final' || isCorrection,
      corrected: isCorrection,
      revision: event.revision,
      firstSequence: previous?.firstSequence ?? finalized?.firstSequence ?? event.sequence,
      lastSequence: event.sequence,
      provenance: event.provenance,
      announce: event.provenance === 'live' && (event.type === 'voice.transcript.final' || isCorrection)
        ? 'polite'
        : 'none',
    });

    if (next.final) deps.persistFinal?.(next);
    items.set(next.itemId, next);
    lastItemEventFingerprints.set(next.itemId, fingerprint);
    if (next.final) rememberFinalizedItem(next, fingerprint);
    rememberEventId(event.eventId, fingerprint);
    if (event.provenance === 'live') lastLiveSequence = event.sequence;
    evictItems();
    deps.onProjection?.(next);
    return { status: 'applied', item: next };
  };

  const admitPersistenceEvent = (
    rawEvent: unknown,
  ): CanonicalVoiceTranscriptPersistenceAdmission | null => {
    const parsed = VoiceTranscriptCanonicalEventV1Schema.safeParse(rawEvent);
    if (!parsed.success) {
      diagnose('invalid_event');
      return null;
    }
    const event = parsed.data;
    if (!isCanonicalVoiceTranscriptPersistenceEvent(event)) {
      diagnose('invalid_event', event);
      return null;
    }

    if (epoch === null) {
      epoch = event.epoch;
      attemptIdentity = createAttemptIdentity();
    }
    if (event.epoch < epoch) {
      diagnose('stale_epoch', event);
      return null;
    }
    if (event.epoch > epoch) {
      diagnose('future_epoch', event);
      return null;
    }
    const fingerprint = eventFingerprint(event);
    const pendingByEventId = pendingAdmittedPersistenceEventsByEventId.get(event.eventId);
    if (pendingByEventId) {
      if (pendingByEventId.fingerprint !== fingerprint) {
        diagnose('conflicting_duplicate', event);
      }
      return null;
    }
    const seenFingerprint = seenEventIds.get(event.eventId);
    if (seenFingerprint !== undefined) {
      if (seenFingerprint !== fingerprint) diagnose('conflicting_duplicate', event);
      return null;
    }

    const previous = items.get(event.itemId) ?? null;
    const finalized = finalizedItemMetadata.get(event.itemId) ?? null;
    const pendingByItemId = pendingAdmittedPersistenceEventsByItemId.get(event.itemId);
    const pendingPredecessor = pendingByItemId ?? null;
    const previousAuthority = pendingPredecessor?.item ?? previous;
    const previousRole = previousAuthority?.role ?? finalized?.role;
    if (previousRole && previousRole !== event.role) {
      diagnose('conflicting_duplicate', event);
      return null;
    }
    const lastItemFingerprint = lastItemEventFingerprints.get(event.itemId);
    if (
      lastItemFingerprint === fingerprint
      || (
        lastItemFingerprint === undefined
        && finalized?.fingerprintDigest === eventFingerprintDigest(fingerprint)
      )
    ) return null;
    if (
      event.provenance === 'live'
      && event.sequence <= Math.max(lastLiveSequence, greatestReservedLiveSequence())
    ) {
      diagnose('out_of_order', event);
      return null;
    }
    const isCorrection = event.type === 'voice.transcript.corrected';
    const hasFinalAuthority = Boolean(pendingPredecessor?.item.final || finalized);
    if (isCorrection && !hasFinalAuthority) {
      diagnose('correction_without_final', event);
      return null;
    }
    if ((pendingPredecessor?.item.final || finalized) && !isCorrection) {
      diagnose('late_after_final', event);
      return null;
    }
    const previousRevision = previousAuthority?.revision ?? finalized?.revision;
    if (previousRevision !== undefined && event.revision <= previousRevision) {
      diagnose('conflicting_duplicate', event);
      return null;
    }
    const previousLastSequence = previousAuthority?.lastSequence ?? finalized?.lastSequence;
    if (
      previousLastSequence !== undefined
      && event.provenance === 'live'
      && event.sequence <= previousLastSequence
    ) {
      diagnose('out_of_order', event);
      return null;
    }

    const item: CanonicalVoiceTranscriptItem = Object.freeze({
      epoch: event.epoch,
      attemptIdentity: attemptIdentity!,
      itemId: event.itemId,
      role: event.role,
      text: event.text,
      final: true,
      corrected: isCorrection,
      revision: event.revision,
      firstSequence: previousAuthority?.firstSequence ?? finalized?.firstSequence ?? event.sequence,
      lastSequence: event.sequence,
      provenance: event.provenance,
      announce: event.provenance === 'live' ? 'polite' : 'none',
    });
    const admission = Object.freeze({}) as CanonicalVoiceTranscriptPersistenceAdmission;
    const pending: PendingAdmittedPersistenceEvent = {
      admission,
      eventId: event.eventId,
      fingerprint,
      item,
      epoch: event.epoch,
      attemptIdentity: attemptIdentity!,
      predecessor: pendingPredecessor,
      successor: null,
      committed: false,
    };
    if (pendingPredecessor) pendingPredecessor.successor = pending;
    admittedPersistenceEvents.set(admission, pending);
    pendingAdmittedPersistenceEventsByEventId.set(event.eventId, pending);
    pendingAdmittedPersistenceEventsByItemId.set(event.itemId, pending);
    return admission;
  };

  const commitAdmittedPersistenceEvent = (
    admission: CanonicalVoiceTranscriptPersistenceAdmission,
  ): CanonicalVoiceTranscriptPersistenceCommit | null => {
    const pending = admittedPersistenceEvents.get(admission);
    if (!pending) return null;
    // Persistence admissions for one item form an arrival-ordered chain. A
    // correction may validate against a still-pending final, but it must never
    // overtake that predecessor at the durable boundary.
    if (pending.predecessor && !pending.predecessor.committed) return null;
    // Consume before the callback: re-entrant or duplicate completion cannot
    // produce a second durable row.
    admittedPersistenceEvents.delete(admission);
    forgetPendingAdmission(pending);
    pending.committed = true;

    const appliedToCurrentSnapshot = (
      epoch === pending.epoch
      && attemptIdentity === pending.attemptIdentity
    );
    if (appliedToCurrentSnapshot) {
      items.set(pending.item.itemId, pending.item);
      lastItemEventFingerprints.set(pending.item.itemId, pending.fingerprint);
      rememberFinalizedItem(pending.item, pending.fingerprint);
      rememberEventId(pending.eventId, pending.fingerprint);
      if (pending.item.provenance === 'live') {
        lastLiveSequence = Math.max(lastLiveSequence, pending.item.lastSequence);
      }
      evictItems();
    }
    deps.persistFinal?.(pending.item);
    if (appliedToCurrentSnapshot) deps.onProjection?.(pending.item);
    return Object.freeze({ item: pending.item, appliedToCurrentSnapshot });
  };

  const releaseAdmittedPersistenceEvent = (
    admission: CanonicalVoiceTranscriptPersistenceAdmission,
  ): boolean => {
    const pending = admittedPersistenceEvents.get(admission);
    if (!pending) return false;
    // A correction admitted against this reservation has no independent
    // authority if its predecessor is cancelled. Release the exact suffix.
    releasePendingAdmissionChain(pending);
    return true;
  };

  return Object.freeze({
    project,
    admitPersistenceEvent,
    commitAdmittedPersistenceEvent,
    releaseAdmittedPersistenceEvent,
    beginAttempt,
    resetEpoch,
    currentAttempt: (): CanonicalVoiceTranscriptAttempt | null => (
      epoch === null || attemptIdentity === null
        ? null
        : Object.freeze({ epoch, attemptIdentity })
    ),
    snapshot: (): readonly CanonicalVoiceTranscriptItem[] => Object.freeze(
      [...items.values()].sort((left, right) => (
        left.firstSequence - right.firstSequence || left.itemId.localeCompare(right.itemId)
      )),
    ),
  });
}

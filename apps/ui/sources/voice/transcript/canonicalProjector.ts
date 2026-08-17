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

export function createCanonicalVoiceTranscriptProjector(deps: CanonicalVoiceTranscriptProjectorDeps = {}) {
  const maxItems = clampPositiveInteger(deps.maxItems, 500);
  const maxDiagnostics = clampPositiveInteger(deps.maxDiagnostics, 64);
  const maxEventIds = Math.max(maxItems * 4, 128);
  const items = new Map<string, CanonicalVoiceTranscriptItem>();
  const seenEventIds = new Map<string, string>();
  const lastItemEventFingerprints = new Map<string, string>();
  const eventIdOrder: string[] = [];
  type PendingAdmittedPersistenceEvent = Readonly<{
    admission: CanonicalVoiceTranscriptPersistenceAdmission;
    eventId: string;
    fingerprint: string;
    item: CanonicalVoiceTranscriptItem;
    epoch: number;
    attemptIdentity: string;
  }>;
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
      pendingAdmittedPersistenceEventsByItemId.delete(pending.item.itemId);
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
    const pendingByItemId = pendingAdmittedPersistenceEventsByItemId.get(event.itemId);
    if (pendingByItemId) {
      return pendingByItemId.fingerprint === fingerprint
        ? { status: 'duplicate', item: null }
        : diagnose('late_after_final', event);
    }
    if (previous && previous.role !== event.role) return diagnose('conflicting_duplicate', event);
    if (previous && lastItemEventFingerprints.get(event.itemId) === fingerprint) {
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
    if (isCorrection && !previous?.final) return diagnose('correction_without_final', event);
    if (previous?.final && !isCorrection) return diagnose('late_after_final', event);
    if (previous && event.revision <= previous.revision) {
      return diagnose('conflicting_duplicate', event);
    }
    if (previous && event.provenance === 'live' && event.sequence <= previous.lastSequence) {
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
      firstSequence: previous?.firstSequence ?? event.sequence,
      lastSequence: event.sequence,
      provenance: event.provenance,
      announce: event.provenance === 'live' && (event.type === 'voice.transcript.final' || isCorrection)
        ? 'polite'
        : 'none',
    });

    if (next.final) deps.persistFinal?.(next);
    items.set(next.itemId, next);
    lastItemEventFingerprints.set(next.itemId, fingerprint);
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
    const pendingByItemId = pendingAdmittedPersistenceEventsByItemId.get(event.itemId);
    if (pendingByItemId) {
      if (pendingByItemId.fingerprint !== fingerprint) diagnose('late_after_final', event);
      return null;
    }
    if (previous && previous.role !== event.role) {
      diagnose('conflicting_duplicate', event);
      return null;
    }
    if (previous && lastItemEventFingerprints.get(event.itemId) === fingerprint) return null;
    if (
      event.provenance === 'live'
      && event.sequence <= Math.max(lastLiveSequence, greatestReservedLiveSequence())
    ) {
      diagnose('out_of_order', event);
      return null;
    }
    const isCorrection = event.type === 'voice.transcript.corrected';
    if (isCorrection && !previous?.final) {
      diagnose('correction_without_final', event);
      return null;
    }
    if (previous?.final && !isCorrection) {
      diagnose('late_after_final', event);
      return null;
    }
    if (previous && event.revision <= previous.revision) {
      diagnose('conflicting_duplicate', event);
      return null;
    }
    if (previous && event.provenance === 'live' && event.sequence <= previous.lastSequence) {
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
      firstSequence: previous?.firstSequence ?? event.sequence,
      lastSequence: event.sequence,
      provenance: event.provenance,
      announce: event.provenance === 'live' ? 'polite' : 'none',
    });
    const admission = Object.freeze({}) as CanonicalVoiceTranscriptPersistenceAdmission;
    const pending: PendingAdmittedPersistenceEvent = Object.freeze({
      admission,
      eventId: event.eventId,
      fingerprint,
      item,
      epoch: event.epoch,
      attemptIdentity: attemptIdentity!,
    });
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
    // Consume before the callback: re-entrant or duplicate completion cannot
    // produce a second durable row.
    admittedPersistenceEvents.delete(admission);
    forgetPendingAdmission(pending);

    const appliedToCurrentSnapshot = (
      epoch === pending.epoch
      && attemptIdentity === pending.attemptIdentity
    );
    if (appliedToCurrentSnapshot) {
      items.set(pending.item.itemId, pending.item);
      lastItemEventFingerprints.set(pending.item.itemId, pending.fingerprint);
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
    admittedPersistenceEvents.delete(admission);
    forgetPendingAdmission(pending);
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

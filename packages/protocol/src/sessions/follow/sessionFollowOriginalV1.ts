import { SessionFollowRuleSourceEvidenceV1Schema, type SessionFollowRuleSourceOccurrenceV1, type SessionFollowRuleSourceEvidenceV1 } from './sessionFollowRuleOccurrenceV1.js';
import type { SessionAwarenessOriginV1, SessionAwarenessProjectionV1 } from '../awareness/projectionV1.js';
import { readSessionAwarenessPresentationV1 } from '../awareness/presentationV1.js';
import { readSessionListStartedByV1 } from '../listFilter/sessionListFilterV1.js';
import type { FollowEventV1 } from './sessionFollowPolicyV1.js';
import { SessionFollowSourceMessageV1Schema, SessionFollowSourceTurnV1Schema } from './sessionFollowSourceOccurrenceV1.js';
import { resolveSessionFollowTurnEventV1 } from './sessionFollowInputV1.js';
import { createTranscriptRawRecordV1Schema, TranscriptRawAgentEventV1Schema } from '../messages/transcriptRawRecordV1.js';
import { SessionMessageV1Schema } from '../messages/sessionMessagesPageV1.js';
import type { SessionMessageRole } from '../messages/sessionMessageRole.js';
import { deriveSessionMessageAuthorAccountIdV1 } from '../messages/sessionMessageAccountActorV1.js';
import { assertSessionInputAdmissionReceiptForAuthorityV1, readSessionInputAuthorityV1, readSessionMessageProvenanceV1,
  settleSessionMessageProvenanceV1, SessionInputRequestV1Schema, SessionMessageProvenanceV1Schema,
  type SessionInputRequestV1, type SessionMessageProvenanceV1 } from '../messages/sessionInputAdmission.js';
import { isAuthoritativeHumanSessionFollowMessageV1 } from './sessionFollowUpdateEnvelopeV1.js';
import { SessionIdSchema } from '../idsV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

type WithoutPublisher<Occurrence> = Occurrence extends unknown ? Omit<Occurrence, 'sourcePublisher'> : never;
export type SessionFollowOriginalOccurrenceV1 = WithoutPublisher<SessionFollowRuleSourceOccurrenceV1>;
export type SessionFollowOriginalReadV1 = Readonly<{ status: 'occurrence'; occurrence: SessionFollowOriginalOccurrenceV1 }>
  | Readonly<{ status: 'not_semantic' }> | Readonly<{ status: 'unavailable' }>;

type SourceFacts = Readonly<{
  serverId: string; ownerAccountId: string; origin: SessionAwarenessOriginV1 | null;
  awareness?: SessionAwarenessProjectionV1;
}>;

/** Potential ingress is not proof; stored originals additionally verify their protected receipt. */
export function isPotentialSessionFollowHumanInputV1(admission: Readonly<{ request: unknown; provenance: unknown }>): boolean {
  const request = SessionInputRequestV1Schema.safeParse(admission.request);
  const provenance = SessionMessageProvenanceV1Schema.safeParse(admission.provenance);
  return request.success && provenance.success && !request.data.returnedAnswer
    && !request.data.followDeliveryV1 && !request.data.sourceSession && !request.data.automation
    && (request.data.producer === 'happierApp' || isAuthoritativeHumanSessionFollowMessageV1({ provenance: provenance.data }));
}

/** Neither an encryption key nor authored metadata grants original human input authority. */
export function readVerifiedSessionFollowHumanInputOriginalV1(input: Readonly<{
  sessionId: string; ownerAccountId: string;
  row: Readonly<{ sidechainId?: string | null; messageRole?: SessionMessageRole | null; inputAdmissionReceipt?: unknown }>;
  meta: unknown;
}>): Readonly<{ request: SessionInputRequestV1; provenance: SessionMessageProvenanceV1; authorAccountId?: string }> | null {
  if ((input.row.sidechainId !== undefined && input.row.sidechainId !== null) || input.row.messageRole !== 'user') return null;
  const authority = readSessionInputAuthorityV1(input.meta, 'stored');
  const provenance = readSessionMessageProvenanceV1(input.meta, 'stored');
  if (!authority || !provenance || !isAuthoritativeHumanSessionFollowMessageV1({ provenance })) return null;
  try {
    const receipt = assertSessionInputAdmissionReceiptForAuthorityV1({ authority, inputAdmissionReceipt: input.row.inputAdmissionReceipt });
    if (receipt.admittedTarget && (receipt.admittedTarget.sessionId !== input.sessionId
      || receipt.admittedTarget.accountId !== input.ownerAccountId)) return null;
    const { admittedPermissionCeiling: _ceiling, ...permission } = authority.permission;
    const request = SessionInputRequestV1Schema.parse({ ...authority, permission });
    if (!isPotentialSessionFollowHumanInputV1({ request, provenance }) || !sameStrictJsonValue(provenance,
      settleSessionMessageProvenanceV1({ request, requestedProvenance: provenance, inputAdmissionReceipt: receipt }))) return null;
    const authorAccountId = deriveSessionMessageAuthorAccountIdV1({ messageRole: input.row.messageRole,
      inputAdmissionReceipt: input.row.inputAdmissionReceipt }, 'stored');
    return { request, provenance, ...(authorAccountId ? { authorAccountId } : {}) };
  } catch { return null; }
}

// Authored metadata is not semantic evidence. Protected human fields have the proof owner above.
const SourceRawRecordSchema = lazyZodSchema(() => createTranscriptRawRecordV1Schema(z, { metaSchema: z.unknown() }));

/** Pure admission of an opened committed row; transport, source access and keys stay with the caller. */
export function readOpenedSessionFollowOriginalV1(input: Pick<SourceFacts, 'serverId' | 'ownerAccountId' | 'origin'> & Readonly<{
  sourceSessionId: string; row: unknown; opened: unknown;
}>): SessionFollowOriginalReadV1 {
  const row = SessionMessageV1Schema.safeParse(input.row);
  const sourceSessionId = SessionIdSchema.safeParse(input.sourceSessionId);
  if (!row.success || !sourceSessionId.success) return { status: 'unavailable' };
  if (row.data.sidechainId) return { status: 'not_semantic' };
  try {
    const body = SourceRawRecordSchema.safeParse(input.opened);
    if (!body.success) return { status: 'unavailable' };
    if (body.data.sidechainId || body.data.role === 'agent' && 'sidechainId' in body.data.content
      && body.data.content.sidechainId) return { status: 'not_semantic' };
    let event: FollowEventV1 | null;
    if (body.data.role === 'user') {
      event = readVerifiedSessionFollowHumanInputOriginalV1({ sessionId: sourceSessionId.data,
        ownerAccountId: input.ownerAccountId, row: row.data, meta: body.data.meta }) ? { kind: 'person_wrote' } : null;
    } else {
      if (row.data.messageRole === 'user') return { status: 'unavailable' };
      const content = body.data.content;
      event = content.type === 'acp' || content.type === 'codex'
        ? readSessionFollowSemanticSourceEventV1(content.data)
        : content.type === 'event' ? readSessionFollowSemanticSourceEventV1(content) : null;
    }
    if (!event) return { status: 'not_semantic' };
    if (event.kind === 'finished' || event.kind === 'failed_or_stopped') {
      const content = body.data.role === 'agent' ? body.data.content : null;
      const ready = content?.type === 'event' ? createStoredReadSchema(TranscriptRawAgentEventV1Schema).safeParse(content.data) : null;
      const native = content?.type === 'acp' || content?.type === 'codex' ? content.data : null;
      const nativeType = native && typeof native === 'object' && 'type' in native ? native.type : null;
      const meta = body.data.meta;
      const hostTurnId = meta && typeof meta === 'object' && 'runtimeTurnId' in meta ? meta.runtimeTurnId : null;
      // Provider native ids never substitute for a host Turn. Final route admission checks that persisted Turn.
      const parsedTurn = SessionFollowSourceTurnV1Schema.safeParse(ready?.success && ready.data.type === 'ready'
        ? { id: ready.data.completedTurnId, status: 'completed' }
        : { id: hostTurnId, status: nativeType === 'task_complete' ? 'completed'
          : nativeType === 'turn_failed' ? 'failed'
            : nativeType === 'turn_cancelled' || nativeType === 'turn_aborted' ? 'cancelled' : null });
      if (!parsedTurn.success) return { status: 'not_semantic' };
      const evidence = captureSemanticSessionFollowRuleSourceEvidenceV1({ ...input, event: resolveSessionFollowTurnEventV1(parsedTurn.data) });
      return evidence ? { status: 'occurrence', occurrence: { sourceSessionId: sourceSessionId.data, sourceTurn: parsedTurn.data, evidence } }
        : { status: 'unavailable' };
    }
    const sourceMessage = SessionFollowSourceMessageV1Schema.safeParse({ localId: row.data.localId, seq: row.data.seq });
    if (!sourceMessage.success) return { status: 'unavailable' };
    const evidence = captureSemanticSessionFollowRuleSourceEvidenceV1({ ...input, event });
    return evidence ? { status: 'occurrence', occurrence: { sourceSessionId: sourceSessionId.data, sourceMessage: sourceMessage.data, evidence } }
      : { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
}

/** One classifier for typed producers and opened stored originals, never authored metadata hints. */
export function readSessionFollowSemanticSourceEventV1(body: Readonly<{
  type: string; sidechainId?: unknown; message?: unknown; data?: unknown;
}>): FollowEventV1 | null {
  if (body.sidechainId) return null;
  if (body.type === 'event') {
    const event = createStoredReadSchema(TranscriptRawAgentEventV1Schema).safeParse(body.data);
    return event.success && event.data.type === 'worker-report' ? { kind: 'update_posted' }
      : event.success && event.data.type === 'goal-changed' ? { kind: 'goal_changed' }
        : event.success && event.data.type === 'ready' && typeof event.data.completedTurnId === 'string' ? { kind: 'finished' } : null;
  }
  return body.type === 'message' && typeof body.message === 'string' && body.message.trim() ? { kind: 'message' }
    : body.type === 'task_complete' ? { kind: 'finished' }
      : body.type === 'turn_failed' || body.type === 'turn_cancelled' || body.type === 'turn_aborted' ? { kind: 'failed_or_stopped' } : null;
}

/** Only original semantic owners supply this event; authored metadata never does. */
export function captureSemanticSessionFollowRuleSourceEvidenceV1(input: SourceFacts & Readonly<{ event: FollowEventV1 }>): SessionFollowRuleSourceEvidenceV1 | null {
  const event = input.event;
  const parsed = SessionFollowRuleSourceEvidenceV1Schema.safeParse({ v: 1, ownerAccountId: input.ownerAccountId, event,
    facts: { serverId: input.serverId, kind: 'session', startedBy: readSessionListStartedByV1({ origin: input.origin ?? undefined,
      ownerAccountId: input.ownerAccountId, viewerAccountId: input.ownerAccountId }), source: 'persisted',
      ...(input.awareness ? { status: readSessionAwarenessPresentationV1(input.awareness) } : {}),
      ...(event.kind === 'needs_you' ? { attentionRequired: true } : {}),
    },
  });
  return parsed.success ? parsed.data : null;
}

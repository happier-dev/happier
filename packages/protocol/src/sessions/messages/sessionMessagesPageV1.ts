import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { MessageActionReferenceV1Schema } from './messageActionReferenceV1.js';
import { SessionMessageAccountActorV1Schema } from './sessionMessageAccountActorV1.js';
import { SessionInputAdmissionReceiptV1Schema } from './sessionInputAdmission.js';
import { SessionMessageAttentionImpactSchema } from './transcriptRawRecordV1.js';
import { SessionMessageDeliveryResolutionV1Schema } from './sessionMessageDeliveryResolutionV1.js';
import { SessionMessageRoleSchema, type SessionMessageRole } from './sessionMessageRole.js';
import { SessionMessageToolOutputAvailabilitySchema, SessionStoredMessageContentSchema, StrictSessionStoredMessageContentEnvelopeSchema } from './sessionStoredMessageContent.js';
import { SessionTranscriptObservationProvenanceV1Schema, SessionTranscriptSurfaceItemReferenceInputV1Schema } from './transcriptObservationV1.js';
import { FollowDeliveryProjectionV1Schema } from '../follow/sessionFollowDeliveryProjectionV1.js';
import {
  ExternalShareableActorV1Schema,
  ExternalShareableTranscriptSnapshotV1Schema,
} from './sessionExternalShareableTranscriptV1.js';

/** Additive reader projection; unknown presentation fields are dropped, never trusted. */
export const SessionMessageV1Schema = lazyZodSchema(() => z.object({
  id: z.string().check(z.minLength(1)), seq: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)), localId: z.nullish(z.string()),
  sidechainId: z.optional(z.nullable(z.string())),
  messageRole: z.nullish(SessionMessageRoleSchema),
  attentionImpact: z.optional(SessionMessageAttentionImpactSchema),
  content: SessionStoredMessageContentSchema,
  toolOutputAvailability: z.optional(SessionMessageToolOutputAvailabilitySchema),
  toolOutputPart: z.optional(StrictSessionStoredMessageContentEnvelopeSchema),
  createdAt: z.number(), updatedAt: z.optional(z.number()),
  sourceCreatedAt: z.optional(z.number().check(z.int(), z.minimum(0))),
  sourceUpdatedAt: z.optional(z.number().check(z.int(), z.minimum(0))),
  transcriptObservationProvenance: z.optional(SessionTranscriptObservationProvenanceV1Schema),
  surfaceItemReference: z.optional(z.nullable(SessionTranscriptSurfaceItemReferenceInputV1Schema)),
  deliveryResolution: z.optional(SessionMessageDeliveryResolutionV1Schema),
  pendingOwnsTranscript: z.optional(z.literal(true)),
  followDeliveryProjection: z.optional(FollowDeliveryProjectionV1Schema),
  messageActionReference: z.optional(MessageActionReferenceV1Schema),
  accountActor: z.optional(z.nullable(SessionMessageAccountActorV1Schema)),
  inputAdmissionReceipt: z.optional(SessionInputAdmissionReceiptV1Schema),
}));
export type SessionMessageV1 = z.infer<typeof SessionMessageV1Schema>;
/** Current main-session activity facts captured with this transcript page. */
export const SessionMessagePageActivityV1Schema = lazyZodSchema(() => z.object({
  pendingCount: z.number().check(z.int(), z.minimum(0)),
  pendingBlockedCount: z.number().check(z.int(), z.minimum(0)),
  pendingBlockedNoEffectCount: z.number().check(z.int(), z.minimum(0)),
  pendingPermissionRequestCount: z.number().check(z.int(), z.minimum(0)),
  pendingUserActionRequestCount: z.number().check(z.int(), z.minimum(0)),
  latestTurnStatus: z.nullable(z.string()),
}));
export type SessionMessagePageActivityV1 = z.infer<typeof SessionMessagePageActivityV1Schema>;
export const SessionMessagesPageV1Schema = lazyZodSchema(() => z.object({
  activity: z.optional(SessionMessagePageActivityV1Schema),
  messages: z.array(SessionMessageV1Schema), hasMore: z.optional(z.boolean()),
  nextBeforeSeq: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)))), nextAfterSeq: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)))),
}));
export type SessionMessagesPageV1 = z.infer<typeof SessionMessagesPageV1Schema>;
/** The standard loaded transcript window shared by Session roster readers. */
export const SESSION_MESSAGES_PAGE_SIZE = 150;
// An external publication row may be an opaque cursor witness. Invalid content
// and coarse actors are omitted; Account identity never crosses this projection.
export const SessionExternalShareableMessagesPageV1Schema = lazyZodSchema(() => z.extend(z.omit(SessionMessagesPageV1Schema, { activity: true }), {
  messages: z.array(z.extend(z.omit(SessionMessageV1Schema, { content: true, accountActor: true, inputAdmissionReceipt: true, followDeliveryProjection: true, pendingOwnsTranscript: true, toolOutputAvailability: true, toolOutputPart: true }), {
    content: z.pipe(z.optional(z.unknown()), z.transform((input) => {
      const parsed = SessionStoredMessageContentSchema.safeParse(input);
      return parsed.success ? parsed.data : undefined;
    })),
    externalShareableActor: z.pipe(z.optional(z.unknown()), z.transform((input) => {
      const parsed = ExternalShareableActorV1Schema.safeParse(input);
      return parsed.success ? parsed.data : undefined;
    })),
  })),
  publicationBlocked: z.optional(z.boolean()),
  externalShareableSnapshot: z.optional(ExternalShareableTranscriptSnapshotV1Schema),
}));
export type SessionMessagesPageScope = 'main' | 'sidechain' | 'all';
export type BuildSessionMessagesPathParams = Readonly<{
  sessionId: string; scope: SessionMessagesPageScope; sidechainId?: string | null;
  limit?: number; beforeSeq?: number; afterSeq?: number; messageId?: string; includeToolOutput?: true;
  role?: SessionMessageRole; roles?: readonly SessionMessageRole[]; projection?: 'turns' | 'externalShareableV1' | 'activity';
}>;
function appendFiniteInteger(query: URLSearchParams, key: string, value: number | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) query.set(key, String(Math.trunc(value)));
}
export function buildSessionMessagesPath(params: BuildSessionMessagesPathParams): string {
  if (params.messageId !== undefined && (params.beforeSeq !== undefined || params.afterSeq !== undefined || params.projection !== undefined)) {
    throw new Error('Exact message selection cannot be combined with paging or projection');
  }
  if (params.includeToolOutput && !params.messageId) {
    throw new Error('Tool output requires exact message selection');
  }
  const query = new URLSearchParams({ scope: params.scope });
  if (params.includeToolOutput) query.set('includeToolOutput', 'true');
  if (params.role) query.set('role', params.role);
  if (params.roles?.length) query.set('roles', params.roles.join(','));
  if (params.projection) query.set('projection', params.projection);
  if (params.messageId !== undefined) query.set('messageId', params.messageId);
  else appendFiniteInteger(query, 'limit', params.limit);
  appendFiniteInteger(query, 'beforeSeq', params.beforeSeq);
  appendFiniteInteger(query, 'afterSeq', params.afterSeq);
  const sidechainId = params.sidechainId?.trim();
  if (params.scope === 'sidechain' && sidechainId) query.set('sidechainId', sidechainId);
  return `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages?${query.toString()}`;
}

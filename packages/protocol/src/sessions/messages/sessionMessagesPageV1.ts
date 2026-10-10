import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { MessageActionReferenceV1Schema } from './messageActionReferenceV1.js';
import { SessionMessageAccountActorV1Schema } from './sessionMessageAccountActorV1.js';
import { SessionInputAdmissionReceiptV1Schema } from './sessionInputAdmission.js';
import { SessionMessageAttentionImpactSchema } from './transcriptRawRecordV1.js';
import { SessionMessageDeliveryResolutionV1Schema } from './sessionMessageDeliveryResolutionV1.js';
import { SessionMessageRoleSchema, type SessionMessageRole } from './sessionMessageRole.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { SessionTranscriptObservationProvenanceV1Schema } from './transcriptObservationV1.js';
import {
  ExternalShareableActorV1Schema,
  ExternalShareableTranscriptSnapshotV1Schema,
} from './sessionExternalShareableTranscriptV1.js';

/** Additive reader projection; unknown presentation fields are dropped, never trusted. */
export const SessionMessageV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1), seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), localId: z.string().nullish(),
  sidechainId: z.string().nullable().optional(),
  messageRole: SessionMessageRoleSchema.nullish(),
  attentionImpact: SessionMessageAttentionImpactSchema.optional(),
  content: SessionStoredMessageContentSchema,
  createdAt: z.number().finite(), updatedAt: z.number().finite().optional(),
  sourceCreatedAt: z.number().int().min(0).optional(),
  sourceUpdatedAt: z.number().int().min(0).optional(),
  transcriptObservationProvenance: SessionTranscriptObservationProvenanceV1Schema.optional(),
  deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
  messageActionReference: MessageActionReferenceV1Schema.optional(),
  accountActor: SessionMessageAccountActorV1Schema.nullable().optional(),
  inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.optional(),
}));
export type SessionMessageV1 = z.infer<typeof SessionMessageV1Schema>;
export const SessionMessagesPageV1Schema = lazyZodSchema(() => z.object({
  messages: z.array(SessionMessageV1Schema), hasMore: z.boolean().optional(),
  nextBeforeSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(), nextAfterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}));
export type SessionMessagesPageV1 = z.infer<typeof SessionMessagesPageV1Schema>;
// An external publication row may be an opaque cursor witness. Invalid content
// and coarse actors are omitted; Account identity never crosses this projection.
export const SessionExternalShareableMessagesPageV1Schema = lazyZodSchema(() => SessionMessagesPageV1Schema.extend({
  messages: z.array(SessionMessageV1Schema.omit({ content: true, accountActor: true, inputAdmissionReceipt: true }).extend({
    content: z.unknown().transform((input) => {
      const parsed = SessionStoredMessageContentSchema.safeParse(input);
      return parsed.success ? parsed.data : undefined;
    }),
    externalShareableActor: z.unknown().transform((input) => {
      const parsed = ExternalShareableActorV1Schema.safeParse(input);
      return parsed.success ? parsed.data : undefined;
    }),
  })),
  publicationBlocked: z.boolean().optional(),
  externalShareableSnapshot: ExternalShareableTranscriptSnapshotV1Schema.optional(),
}));
export type SessionMessagesPageScope = 'main' | 'sidechain' | 'all';
export type BuildSessionMessagesPathParams = Readonly<{
  sessionId: string; scope: SessionMessagesPageScope; sidechainId?: string | null;
  limit?: number; beforeSeq?: number; afterSeq?: number;
  role?: SessionMessageRole; roles?: readonly SessionMessageRole[]; projection?: 'turns' | 'externalShareableV1';
}>;
function appendFiniteInteger(query: URLSearchParams, key: string, value: number | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) query.set(key, String(Math.trunc(value)));
}
export function buildSessionMessagesPath(params: BuildSessionMessagesPathParams): string {
  const query = new URLSearchParams({ scope: params.scope });
  if (params.role) query.set('role', params.role);
  if (params.roles?.length) query.set('roles', params.roles.join(','));
  if (params.projection) query.set('projection', params.projection);
  appendFiniteInteger(query, 'limit', params.limit);
  appendFiniteInteger(query, 'beforeSeq', params.beforeSeq);
  appendFiniteInteger(query, 'afterSeq', params.afterSeq);
  const sidechainId = params.sidechainId?.trim();
  if (params.scope === 'sidechain' && sidechainId) query.set('sidechainId', sidechainId);
  return `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages?${query.toString()}`;
}

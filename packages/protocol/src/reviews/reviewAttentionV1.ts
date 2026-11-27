import { ActionActorV1Schema } from '../actions/actionActorV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion, type ProtocolSchemaOutput } from '../plugins/actions/protocolComposableSchema.js';
import { ReviewSubjectKindV1ProtocolSchema } from './reviewArtifactV1.js';

/** Presentation facts from the Review owner; the stable attention reason is separate. */
export const ReviewAttentionV1ProtocolSchema = defineProtocolObject({
  requestedVerdict: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
  subjectKind: ReviewSubjectKindV1ProtocolSchema,
  requestedBy: projectZodProtocolSchema(ActionActorV1Schema).optional(),
}, { policy: 'closed' });
export type ReviewAttentionV1 = ProtocolSchemaOutput<typeof ReviewAttentionV1ProtocolSchema>;
export const ReviewAttentionV1Schema = asProtocolZod(ReviewAttentionV1ProtocolSchema);

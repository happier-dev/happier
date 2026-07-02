import { z } from 'zod';

import {
    ParticipantRecipientV1Schema,
    type ParticipantRecipientV1,
} from '@happier-dev/protocol';

export const ExecutionRunDeliveryModeSchema = z.enum(['prompt', 'steer_if_supported', 'interrupt']);
export type ExecutionRunDeliveryMode = z.infer<typeof ExecutionRunDeliveryModeSchema>;

const StructuredInputMentionBaseSchema = z.object({
    tokenText: z.string().min(1),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
}).refine((value) => value.end >= value.start, {
    message: 'Mention end must be greater than or equal to start',
});

export const ComposerVendorPluginMentionSchema = StructuredInputMentionBaseSchema.extend({
    kind: z.literal('vendorPlugin'),
    vendorPluginRef: z.string().min(1),
    label: z.string().min(1).optional(),
    backendId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
});

export const ComposerSkillMentionSchema = StructuredInputMentionBaseSchema.extend({
    kind: z.literal('skill'),
    name: z.string().min(1),
    path: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    origin: z.string().min(1).optional(),
    projectionKind: z.string().min(1).optional(),
});

export const ComposerStructuredInputMentionSchema = z.discriminatedUnion('kind', [
    ComposerVendorPluginMentionSchema,
    ComposerSkillMentionSchema,
]);
export const ComposerStructuredInputMentionsSchema = z.array(ComposerStructuredInputMentionSchema);
export type ComposerStructuredInputMention = z.infer<typeof ComposerStructuredInputMentionSchema>;

export type SessionDraftValueByFieldId = Readonly<{
    'routing.recipient': ParticipantRecipientV1 | null;
    'routing.executionRunDelivery': ExecutionRunDeliveryMode;
    'structuredInput.mentions': readonly ComposerStructuredInputMention[];
}>;

export type SessionDraftValueFieldId = keyof SessionDraftValueByFieldId;

export const SESSION_DRAFT_VALUE_SCHEMAS = {
    'routing.recipient': ParticipantRecipientV1Schema.nullable(),
    'routing.executionRunDelivery': ExecutionRunDeliveryModeSchema,
    'structuredInput.mentions': ComposerStructuredInputMentionsSchema,
} satisfies Readonly<Record<SessionDraftValueFieldId, z.ZodType>>;

export type SessionDraftValueEnvelope<FieldId extends SessionDraftValueFieldId = SessionDraftValueFieldId> = Readonly<{
    v: 1;
    updatedAt: number;
    lastEditedAt: number;
    value: SessionDraftValueByFieldId[FieldId];
}>;

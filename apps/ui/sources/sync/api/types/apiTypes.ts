import { z } from 'zod';
import { ChangeEntrySchema, ChangesResponseSchema } from '@happier-dev/protocol/changes';
import {
    SessionMessageAttentionImpactSchema,
    SessionMessageDeliveryResolutionV1Schema,
    SessionMessageRoleSchema,
    SessionStoredMessageContentSchema,
    SessionTranscriptObservationProvenanceV1Schema,
} from '@happier-dev/protocol';
import { EphemeralUpdateSchema, type EphemeralUpdate, UpdateBodySchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';

//
// Session message
//

export const ApiMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    localId: z.string().nullish(),
    sidechainId: z.string().nullable().optional(),
    messageRole: SessionMessageRoleSchema.nullish(),
    attentionImpact: SessionMessageAttentionImpactSchema.optional(),
    content: SessionStoredMessageContentSchema,
    createdAt: z.number(),
    updatedAt: z.number().optional(),
    sourceCreatedAt: z.number().int().min(0).optional(),
    sourceUpdatedAt: z.number().int().min(0).optional(),
    transcriptObservationProvenance: SessionTranscriptObservationProvenanceV1Schema.optional(),
    deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
});

export type ApiMessage = z.infer<typeof ApiMessageSchema>;

export const ApiSessionMessagesResponseSchema = z.object({
    messages: z.array(ApiMessageSchema),
    hasMore: z.boolean().optional(),
    nextBeforeSeq: z.number().nullable().optional(),
    nextAfterSeq: z.number().nullable().optional(),
});

//
// /v2/changes
//

export const ApiChangeEntrySchema = ChangeEntrySchema;
export type ApiChangeEntry = z.infer<typeof ApiChangeEntrySchema>;

export const ApiChangesResponseSchema = ChangesResponseSchema;
export type ApiChangesResponse = z.infer<typeof ApiChangesResponseSchema>;

export type ApiSessionMessagesResponse = z.infer<typeof ApiSessionMessagesResponseSchema>;

//
// Updates
//

export const ApiUpdateSchema = UpdateBodySchema;
export type ApiUpdate = z.infer<typeof ApiUpdateSchema>;

//
// API update container
//

export const ApiUpdateContainerSchema = UpdateContainerSchema;
export type ApiUpdateContainer = z.infer<typeof ApiUpdateContainerSchema>;

//
// Ephemeral update
//

export const ApiEphemeralUpdateSchema = EphemeralUpdateSchema;
export type ApiEphemeralUpdate = EphemeralUpdate;
export type ApiEphemeralActivityUpdate = Extract<ApiEphemeralUpdate, { type: 'activity' }>;

// Machine metadata updates use Partial<MachineMetadata> from storageTypes
// This matches how session metadata updates work

import { z } from 'zod/mini';
import { SessionOrganizationPlacementV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionOwnerMetadataEnvelopeV1Schema, SessionDisplayProjectionV1Schema, SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionInitialAccessMaterializedV1Schema } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import { SessionInitialTriggerAdmissionV1Schema } from '@happier-dev/protocol/sessions/creation/sessionInitialTriggerAdmissionV1';
import { SessionCreateOriginFieldsV1Schema, refineSessionCreateOriginFieldsV1 } from '@happier-dev/protocol/sessions/creation/sessionCreateOriginV1';
import { SessionManagerV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { SessionActionChildCreationProofV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';

/** The ordinary birth route and signed effect admission consume one exact body contract. */
export const SessionCreateRequestSchema = z.union([z.strictObject({
    tag: z.string(),
    metadata: z.string(),
    agentState: z.nullish(z.string()),
    dataEncryptionKey: z.nullish(z.string()),
    encryptionMode: z.optional(z.enum(['e2ee', 'plain'])),
    currentStorageState: z.optional(z.literal('machine_only')),
}), z.strictObject({
    tag: z.string(),
    metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
    sharedMetadata: z.strictObject({ ciphertext: z.string().check(z.minLength(1)) }),
    ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
    displayProjectionV1: z.optional(z.nullable(SessionDisplayProjectionV1Schema)),
    agentState: z.nullish(z.string()),
    dataEncryptionKey: z.nullish(z.string()),
    encryptionMode: z.optional(z.enum(['e2ee', 'plain'])),
    currentStorageState: z.optional(z.literal('machine_only')),
    organizationPlacement: z.optional(SessionOrganizationPlacementV1Schema),
    initialAccess: z.optional(SessionInitialAccessMaterializedV1Schema),
    initialTriggers: z.optional(z.array(SessionInitialTriggerAdmissionV1Schema)),
    primaryTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    teamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema),
    manager: z.optional(SessionManagerV1Schema),
    creationAuthorizationProof: z.optional(SessionActionChildCreationProofV1Schema),
    templateRequesterAuthorization: z.optional(z.strictObject({
        authorization: ExternalActionExecutionAuthorizationV1Schema,
        originalActionEnvelope: ExternalActionRequestEnvelopeSchema,
    })),
    ...SessionCreateOriginFieldsV1Schema.shape,
}).check(z.superRefine(refineSessionCreateOriginFieldsV1))]);

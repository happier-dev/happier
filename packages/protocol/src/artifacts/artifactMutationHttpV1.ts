import { z } from 'zod/mini';
import { ArtifactCreateIdV1Schema } from './artifactIdV1.js';
import { ApprovalArtifactQueryHintsV1Schema } from '../approvals/approvalArtifactKindV1.js';
import { ArtifactBlobWriteV1Schema } from './artifactBinaryV1.js';
import { ArtifactStoredKindV1Schema } from './artifactKindV1.js';
import { CoordinationMessageRefV1Schema } from '../discussions/messageRefs.js';
import { ArtifactIdScopeV1Schema } from './idScope.js';
export { ArtifactIdScopeV1Schema, deriveAccountScopedArtifactIdV1, resolveAccountScopedArtifactIdV1, artifactIdScopeMatchesAccountV1, type ArtifactIdScopeV1 } from './idScope.js';

/** Canonical JSON wire grammar shared by Artifact routes and atomic domain transactions. */
export function createArtifactCreateHttpInputV1Schema(input: Readonly<{
    requiresBlob: boolean;
    requiresMemoryDecisionSource: boolean;
}>) {
    return z.strictObject({
        id: ArtifactCreateIdV1Schema,
        idScope: z.optional(ArtifactIdScopeV1Schema),
        kind: z.optional(ArtifactStoredKindV1Schema),
        approvalState: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalState),
        approvalSessionId: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalSessionId),
        header: z.string(),
        body: z.string(),
        dataEncryptionKey: z.string(),
        blob: z.optional(ArtifactBlobWriteV1Schema),
        memoryDecisionSource: input.requiresMemoryDecisionSource ? CoordinationMessageRefV1Schema : z.optional(z.never()),
        provenance: z.optional(z.nullable(z.string())),
        provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
    }).check(z.refine(value => input.requiresBlob ? value.blob !== undefined : value.blob === undefined));
}

export const ArtifactJsonCreateHttpInputV1Schema = createArtifactCreateHttpInputV1Schema({
    requiresBlob: false,
    requiresMemoryDecisionSource: false,
});

export function createArtifactUpdateHttpInputV1Schema(input: Readonly<{
    requiresBlob: boolean;
    requiresMemoryDecisionSource: boolean;
}>) {
    return z.strictObject({
        header: z.optional(z.string()),
        kind: z.optional(ArtifactStoredKindV1Schema),
        approvalState: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalState),
        approvalSessionId: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalSessionId),
        expectedHeaderVersion: z.optional(z.number().check(z.int(), z.minimum(0))),
        body: z.optional(z.string()),
        expectedBodyVersion: z.optional(z.number().check(z.int(), z.minimum(0))),
        provenance: z.optional(z.nullable(z.string())),
        provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
        blob: z.optional(z.nullable(ArtifactBlobWriteV1Schema)),
        memoryDecisionSource: input.requiresMemoryDecisionSource
            ? CoordinationMessageRefV1Schema : z.optional(z.never()),
    }).check(z.refine(value => input.requiresBlob ? value.blob !== undefined : value.blob === undefined));
}

export const ArtifactJsonUpdateHttpInputV1Schema = createArtifactUpdateHttpInputV1Schema({
    requiresBlob: false,
    requiresMemoryDecisionSource: false,
});
export type ArtifactJsonUpdateHttpInputV1 = z.infer<typeof ArtifactJsonUpdateHttpInputV1Schema>;

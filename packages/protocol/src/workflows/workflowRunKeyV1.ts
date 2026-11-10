import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import {
  ArtifactAccessRecipientCensusResponseV1Schema,
  ArtifactRecipientKeyEnvelopeInputV1Schema,
  ArtifactRecipientKeyEnvelopeCommitResponseV1Schema,
} from '../artifacts/artifactAccessV1.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { AutomationAccountCurrentnessWitnessV1Schema } from '../automations/automationAccountCurrentnessV1.js';
import { WorkflowRunIdV1Schema, WorkflowDefinitionIdV1Schema } from './workflowIdsV1.js';

/** Run-key wire epoch V1: authority, mutation and all nested objects are closed. */
export const WorkflowRunRecipientKeyEnvelopeV1Schema = ArtifactRecipientKeyEnvelopeInputV1Schema;
export type WorkflowRunRecipientKeyEnvelopeV1 = z.infer<typeof WorkflowRunRecipientKeyEnvelopeV1Schema>;
export const WorkflowRunRecipientKeyEnvelopesV1Schema = lazyZodSchema(() => z.array(WorkflowRunRecipientKeyEnvelopeV1Schema).check(z.refine(items => new Set(items.map(item => item.recipientAccountId)).size === items.length, { message: 'Duplicate recipientAccountId' })));
export const WorkflowRunRecipientCensusInputV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  sourceArtifactId: z.optional(z.nullable(WorkflowDefinitionIdV1Schema)),
  visibleTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
}));
export type WorkflowRunRecipientCensusInputV1 = z.infer<typeof WorkflowRunRecipientCensusInputV1Schema>;
export const WorkflowRunRecipientCensusResponseV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ArtifactAccessRecipientCensusResponseV1Schema, { artifactId: true }), {
  runId: WorkflowRunIdV1Schema,
  visibleTeamId: z.nullable(z.string().check(z.minLength(1))),
  ownerAccountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
})));
export type WorkflowRunRecipientCensusResponseV1 = z.infer<typeof WorkflowRunRecipientCensusResponseV1Schema>;
/** A missing exact Run may prepare its audience in the same admission read. */
export const WorkflowRunAdmissionPreparationInputV1Schema = lazyZodSchema(() => z.omit(WorkflowRunRecipientCensusInputV1Schema, { runId: true }));
export const WorkflowRunAdmissionPreparationResultV1Schema = lazyZodSchema(() => z.strictObject({
  run: z.null(),
  keyCensus: WorkflowRunRecipientCensusResponseV1Schema,
}));
export const WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema,
  expectedDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema,
  recipientKeyEnvelopes: WorkflowRunRecipientKeyEnvelopesV1Schema,
}));
export type WorkflowRunRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema>;
export const WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema = ArtifactRecipientKeyEnvelopeCommitResponseV1Schema;
export type WorkflowRunRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema>;

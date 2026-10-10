import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
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
export const WorkflowRunRecipientKeyEnvelopesV1Schema = lazyZodSchema(() => z.array(WorkflowRunRecipientKeyEnvelopeV1Schema).refine(
  items => new Set(items.map(item => item.recipientAccountId)).size === items.length,
  { message: 'Duplicate recipientAccountId' },
));
export const WorkflowRunRecipientCensusInputV1Schema = lazyZodSchema(() => z.object({
  runId: WorkflowRunIdV1Schema,
  sourceArtifactId: WorkflowDefinitionIdV1Schema.nullable().optional(),
  visibleTeamId: z.string().min(1).nullable().optional(),
}).strict());
export type WorkflowRunRecipientCensusInputV1 = z.infer<typeof WorkflowRunRecipientCensusInputV1Schema>;
export const WorkflowRunRecipientCensusResponseV1Schema = lazyZodSchema(() => ArtifactAccessRecipientCensusResponseV1Schema.omit({ artifactId: true }).extend({
  runId: WorkflowRunIdV1Schema,
  visibleTeamId: z.string().min(1).nullable(),
  ownerAccountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
}).strict());
export type WorkflowRunRecipientCensusResponseV1 = z.infer<typeof WorkflowRunRecipientCensusResponseV1Schema>;
export const WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema = lazyZodSchema(() => z.object({
  runId: WorkflowRunIdV1Schema,
  expectedDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema,
  recipientKeyEnvelopes: WorkflowRunRecipientKeyEnvelopesV1Schema,
}).strict());
export type WorkflowRunRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof WorkflowRunRecipientKeyEnvelopeCommitInputV1Schema>;
export const WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema = ArtifactRecipientKeyEnvelopeCommitResponseV1Schema;
export type WorkflowRunRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema>;

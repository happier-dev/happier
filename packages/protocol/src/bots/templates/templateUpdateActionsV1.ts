import { z } from 'zod/mini';
import semver from 'semver';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { ConnectedServiceBindingsV2Schema } from '../../connect/connectedServiceBindings.js';
import { ThreeWayTextChoiceV1Schema, ThreeWayTextComparisonV1Schema } from '../../diff/threeWayText.js';
import { SkillUpdateFileV1Schema } from '../../prompts/library/skills/skillActionSchemasV1.js';
import { BotTemplateInstanceV1Schema } from './templateInstanceV1.js';
import type { BotTemplateInstanceV1 } from './templateInstanceV1.js';
import { BotTemplateSetupSelectionsV1Schema } from './templateSetupSelectionsV1.js';
import { BotTemplateContentV1Schema, BotTemplateDraftRefV1Schema, BotTemplatePreviewResultV1Schema,
  BotTemplateSourceSessionRefV1Schema, BotTemplateVersionV1Schema } from './botTemplateV1.js';

const choices = lazyZodSchema(() => z.record(z.string(), ThreeWayTextChoiceV1Schema));
export const BotTemplateUpdateDiffInputV1Schema = lazyZodSchema(() => z.strictObject({ sessionRef: BotTemplateSourceSessionRefV1Schema }));
export const BotTemplateUpdateDiffResultV1Schema = lazyZodSchema(() => z.strictObject({
  sessionRef: BotTemplateSourceSessionRefV1Schema,
  metadataRevision: z.number().check(z.int(), z.nonnegative()), instance: BotTemplateInstanceV1Schema,
  executionTarget: z.optional(z.strictObject({ machineId: z.string(), agentId: z.string() })),
  connectedServices: z.optional(ConnectedServiceBindingsV2Schema),
  offer: z.enum(['available', 'current', 'skipped', 'stopped']),
  upstream: BotTemplatePreviewResultV1Schema,
  instructions: z.nullable(z.strictObject({ ref: BotTemplateDraftRefV1Schema, title: z.string(), revision: ArtifactRevisionV1Schema, comparison: ThreeWayTextComparisonV1Schema })),
  skills: z.array(z.strictObject({ key: z.string(), title: z.string(), status: z.enum(['added', 'removed', 'existing', 'deleted']),
    canTake: z.boolean(), skillId: z.optional(z.string()), revision: z.optional(z.string()), files: z.array(SkillUpdateFileV1Schema) })),
  needs: BotTemplateContentV1Schema.shape.needs,
}));
export const BotTemplateUpdateApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionRef: BotTemplateSourceSessionRefV1Schema, expectedVersion: BotTemplateVersionV1Schema,
  expectedRevision: z.optional(ArtifactRevisionV1Schema), expectedMetadataRevision: z.number().check(z.int(), z.nonnegative()),
  instructions: z.optional(z.strictObject({ expectedRevision: ArtifactRevisionV1Schema,
    choices: z.optional(choices), markdown: z.optional(z.string()) })),
  skills: z.optional(z.record(z.string(), z.strictObject({ choice: z.enum(['keep', 'take', 'remove', 'skip']),
    expectedRevision: z.optional(z.string()), choices: z.optional(choices), hunkChoices: z.optional(z.record(z.string(), choices)) }))),
  takeIdentity: z.optional(z.boolean()),
  setup: z.optional(BotTemplateSetupSelectionsV1Schema),
  recovery: z.optional(z.strictObject({ skillIds: z.record(z.string(), z.string()), mcpServerIds: z.record(z.string(), z.string()), acceptedBaseId: z.optional(z.string()) })),
}));
export const BotTemplateUpdateApplyResultV1Schema = lazyZodSchema(() => z.strictObject({ acceptedVersion: BotTemplateVersionV1Schema,
  applied: z.array(z.string()), kept: z.array(z.string()), resourceIds: z.array(z.string()) }));
export const BotTemplateUpdateFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({ applied: z.array(z.string()), remaining: z.array(z.string()),
  resourceIds: z.array(z.string()), skillIds: z.optional(z.record(z.string(), z.string())), mcpServerIds: z.optional(z.record(z.string(), z.string())), acceptedBaseId: z.optional(z.string()) }));
export type BotTemplateUpdateFailureDetailsV1 = z.infer<typeof BotTemplateUpdateFailureDetailsV1Schema>;
export const BotTemplateUpdateSkipInputV1Schema = lazyZodSchema(() => z.strictObject({ sessionRef: BotTemplateSourceSessionRefV1Schema, version: BotTemplateVersionV1Schema }));
export const BotTemplateFollowStopInputV1Schema = BotTemplateUpdateDiffInputV1Schema;
export const BotTemplateFollowResultV1Schema = lazyZodSchema(() => z.strictObject({ instance: BotTemplateInstanceV1Schema, changed: z.boolean() }));
export type BotTemplateUpdateDiffInputV1 = z.infer<typeof BotTemplateUpdateDiffInputV1Schema>;
export type BotTemplateUpdateDiffResultV1 = z.infer<typeof BotTemplateUpdateDiffResultV1Schema>;
export type BotTemplateUpdateApplyInputV1 = z.infer<typeof BotTemplateUpdateApplyInputV1Schema>;
export type BotTemplateUpdateApplyResultV1 = z.infer<typeof BotTemplateUpdateApplyResultV1Schema>;

export { compareThreeWayTextV1, resolveThreeWayTextV1 } from '../../diff/threeWayText.js';
/** Both body review and the Info summary use this one offer decision. */
export function readBotTemplateUpdateOfferV1(instance: BotTemplateInstanceV1, offeredVersion: string): 'available' | 'current' | 'skipped' | 'stopped' {
  if (!instance.follow) return 'stopped';
  if (!semver.gt(offeredVersion, instance.acceptedVersion)) return 'current';
  return instance.skippedVersion === offeredVersion ? 'skipped' : 'available';
}

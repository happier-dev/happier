import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactCreateIdV1Schema } from '../../artifacts/artifactIdV1.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { PrincipalRefV1Schema } from '../../teams/principal.js';
import { BOT_TEMPLATE_ACTION_IDS_V1 } from './botTemplateActionIdsV1.js';
import { BotTemplateCandidatesV1Schema, BotTemplateContentV1Schema, BotTemplateReleaseV1Schema,
  BotTemplateReleaseSourceV1Schema, BotTemplateSourceSessionRefV1Schema, BotTemplateVersionV1Schema,
  BotTemplatePreviewResultV1Schema } from './botTemplateV1.js';
export { BotTemplateArtifactPresentationV1Schema, type BotTemplateArtifactPresentationV1,
  BotTemplatePreviewResultV1Schema, type BotTemplatePreviewResultV1 } from './botTemplateV1.js';
import { SessionSpawnNewActionInputV2Schema, SessionServerStartSpawnDraftV1Schema,
  admitSessionSpawnNewActionInputV2, type SessionServerStartSpawnDraftV1 } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { SessionSpawnNewActionResultV1Schema } from '../../sessions/creation/sessionSpawnNewResultV1.js';
import { SessionBotFaceV1Schema } from '../../sessions/identity/sessionBotFaceV1.js';
import { BotTemplateSetupSelectionsV1Schema } from './templateSetupSelectionsV1.js';
export { BotTemplateSetupSelectionsV1Schema, projectBotTemplateSetupSelectionsForReviewV1,
  type BotTemplateSetupSelectionsV1 } from './templateSetupSelectionsV1.js';
import { BotTemplateUpdateDiffInputV1Schema, BotTemplateUpdateDiffResultV1Schema, BotTemplateUpdateApplyInputV1Schema,
  BotTemplateUpdateApplyResultV1Schema, BotTemplateUpdateSkipInputV1Schema, BotTemplateFollowStopInputV1Schema,
  BotTemplateFollowResultV1Schema } from './templateUpdateActionsV1.js';
export * from './templateUpdateActionsV1.js';
export { BotTemplateInstanceV1Schema, type BotTemplateInstanceV1 } from './templateInstanceV1.js';

export { BOT_TEMPLATE_ACTION_IDS_V1 } from './botTemplateActionIdsV1.js';
export const BotTemplateActionIdV1Schema = lazyZodSchema(() => z.enum(BOT_TEMPLATE_ACTION_IDS_V1));
export type BotTemplateActionIdV1 = z.infer<typeof BotTemplateActionIdV1Schema>;
export const BotTemplateDraftInputV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSessionRef: BotTemplateSourceSessionRefV1Schema,
  draftArtifactId: z.optional(ArtifactCreateIdV1Schema),
  /** An editor's observed snapshot; agent and MCP caller schemas omit it. */
  expectedRevision: z.optional(ArtifactRevisionV1Schema),
  content: BotTemplateContentV1Schema, candidates: z.optional(BotTemplateCandidatesV1Schema),
}));
export const BotTemplateReleaseInputV1Schema = lazyZodSchema(() => z.strictObject({
  draftArtifactId: ArtifactCreateIdV1Schema, expectedRevision: ArtifactRevisionV1Schema,
  version: BotTemplateVersionV1Schema, changelog: z.string(),
  releasedAtMs: z.optional(BotTemplateReleaseV1Schema.shape.releasedAtMs),
  share: z.optional(z.strictObject({ recipients: z.array(PrincipalRefV1Schema), signedInLink: z.optional(z.literal(true)) })),
}));
export const BotTemplateOpenInputV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSessionRef: BotTemplateSourceSessionRefV1Schema, draftArtifactId: ArtifactCreateIdV1Schema,
  presentation: z.optional(z.enum(['pane', 'page', 'share'])),
}));
export type BotTemplateDraftInputV1 = z.infer<typeof BotTemplateDraftInputV1Schema>;
export type BotTemplateReleaseInputV1 = z.infer<typeof BotTemplateReleaseInputV1Schema>;
export type BotTemplateOpenInputV1 = z.infer<typeof BotTemplateOpenInputV1Schema>;
export const BotTemplatePreviewInputV1Schema = lazyZodSchema(() => z.strictObject({ source: BotTemplateReleaseSourceV1Schema }));
export const BotTemplateExportFileInputV1Schema = lazyZodSchema(() => z.strictObject({ source: BotTemplateReleaseSourceV1Schema,
  skillKey: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)) }));
export const BotTemplateExportFileResultV1Schema = lazyZodSchema(() => z.strictObject({
  fileName: z.string().check(z.minLength(1)), contentBase64: z.string(), contentKind: z.enum(['utf8', 'binary']) }));
export type BotTemplateExportFileResultV1 = z.infer<typeof BotTemplateExportFileResultV1Schema>;
/** Uses the existing ordinary creation vocabulary; the owner replaces first input and Bot identity. */
export const BotTemplateInstantiateInputV1Schema = lazyZodSchema(() => z.strictObject({
  source: BotTemplateReleaseSourceV1Schema, expectedVersion: BotTemplateVersionV1Schema,
  expectedRevision: z.optional(ArtifactRevisionV1Schema), creation: SessionSpawnNewActionInputV2Schema,
  name: z.optional(z.string().check(z.trim(), z.minLength(1))), face: z.optional(SessionBotFaceV1Schema),
  setup: z.optional(BotTemplateSetupSelectionsV1Schema),
}));
export type BotTemplateInstantiateInputV1 = z.infer<typeof BotTemplateInstantiateInputV1Schema>;
/** Original requester admission binds the public draft; host-sealed birth operands stay local. */
export function projectBotTemplateInstantiationRequesterInputV1(input: BotTemplateInstantiateInputV1):
  Omit<BotTemplateInstantiateInputV1, 'creation'> & Readonly<{ creation: SessionServerStartSpawnDraftV1 }> {
  const creation = admitSessionSpawnNewActionInputV2(input.creation);
  return { ...input, creation: SessionServerStartSpawnDraftV1Schema.parse(Object.fromEntries(
    Object.keys(SessionServerStartSpawnDraftV1Schema.shape).filter(key => Object.hasOwn(creation, key))
      .map(key => [key, Reflect.get(creation, key)]),
  )) };
}
export const BotTemplateDraftResultV1Schema = lazyZodSchema(() => z.strictObject({
  draftArtifactId: ArtifactCreateIdV1Schema, revision: ArtifactRevisionV1Schema,
  sourceSessionRef: BotTemplateSourceSessionRefV1Schema,
  summary: z.strictObject({ identity: BotTemplateContentV1Schema.shape.identity,
    includes: z.strictObject({ memoryRules: z.number().check(z.int(), z.nonnegative()), skills: z.number().check(z.int(), z.nonnegative()),
      software: z.number().check(z.int(), z.nonnegative()), connectedAccounts: z.number().check(z.int(), z.nonnegative()),
      mcpServers: z.number().check(z.int(), z.nonnegative()) }),
    leftOut: z.strictObject({ memoryRules: z.number().check(z.int(), z.nonnegative()), skills: z.number().check(z.int(), z.nonnegative()) }) }),
}));
export type BotTemplateDraftResultV1 = z.infer<typeof BotTemplateDraftResultV1Schema>;
export const BotTemplateReleaseResultV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: ArtifactCreateIdV1Schema, revision: ArtifactRevisionV1Schema, release: BotTemplateReleaseV1Schema, reused: z.boolean(),
}));
export const BotTemplateActionInputSchemasV1 = {
  'template.draft': BotTemplateDraftInputV1Schema,
  'template.release': BotTemplateReleaseInputV1Schema,
  'template.open': BotTemplateOpenInputV1Schema,
  'template.preview': BotTemplatePreviewInputV1Schema,
  'template.export_file': BotTemplateExportFileInputV1Schema,
  'template.instantiate': BotTemplateInstantiateInputV1Schema,
  'template.updates.diff': BotTemplateUpdateDiffInputV1Schema,
  'template.updates.apply': BotTemplateUpdateApplyInputV1Schema,
  'template.updates.skip': BotTemplateUpdateSkipInputV1Schema,
  'template.follow.stop': BotTemplateFollowStopInputV1Schema,
} as const;
export const BotTemplateActionOutputSchemasV1 = {
  'template.draft': BotTemplateDraftResultV1Schema,
  'template.release': BotTemplateReleaseResultV1Schema,
  'template.open': lazyZodSchema(() => z.strictObject({ opened: z.literal(true) })),
  'template.preview': BotTemplatePreviewResultV1Schema,
  'template.export_file': BotTemplateExportFileResultV1Schema,
  'template.instantiate': SessionSpawnNewActionResultV1Schema,
  'template.updates.diff': BotTemplateUpdateDiffResultV1Schema,
  'template.updates.apply': BotTemplateUpdateApplyResultV1Schema,
  'template.updates.skip': BotTemplateFollowResultV1Schema,
  'template.follow.stop': BotTemplateFollowResultV1Schema,
} as const;

import { ThreeWayTextComparisonV1Schema, ThreeWayTextChoiceV1Schema } from '../../../diff/threeWayText.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { AgentIdV1Schema } from '../../../agents/agentIdV1.js';
import { ReachRulesChangeV1Schema } from '../../../reach/reachRulesChangeV1.js';
import { RegistrySkillContentRefV1Schema, RegistryItemPointerV1Schema } from '../../../registries/registryItemsV1.js';
import { SkillCostV1Schema } from './skillCostV1.js';
import { SkillTrustV1Schema } from './skillTrustV1.js';
import { SkillListItemV1Schema, SkillUnavailableItemV1Schema, SkillProvenanceV1Schema, SkillRevisionV1Schema } from './skillLibraryItemV1.js';
import { ArtifactSavedByV1Schema } from '../../../artifacts/artifactBinaryV1.js';

export const SkillFileInputV1Schema = lazyZodSchema(() => z.strictObject({ path: z.string().check(z.minLength(1)), contentBase64: z.string(),
  contentKind: z.enum(['utf8', 'binary']), unixMode: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(0o7777)))) }));
export type SkillFileInputV1 = z.infer<typeof SkillFileInputV1Schema>;
export const SkillUpdateCandidateV1Schema = lazyZodSchema(() => z.strictObject({ baseFiles: z.array(SkillFileInputV1Schema), files: z.array(SkillFileInputV1Schema) }));
export type SkillUpdateCandidateV1 = z.infer<typeof SkillUpdateCandidateV1Schema>;
export const SkillUpdateChoiceV1Schema = ThreeWayTextChoiceV1Schema;
export type SkillUpdateChoiceV1 = z.infer<typeof SkillUpdateChoiceV1Schema>;
export const SkillActionFailureResultV1Schema = lazyZodSchema(() => z.strictObject({ ok: z.literal(false), code: z.string().check(z.minLength(1)), current: z.optional(SkillListItemV1Schema) }));
export type SkillActionFailureResultV1 = z.infer<typeof SkillActionFailureResultV1Schema>;
export const SkillFileChangeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('upsert'), file: SkillFileInputV1Schema }),
  z.strictObject({ kind: z.literal('remove'), path: z.string().check(z.minLength(1)) }),
]));
const skillId = lazyZodSchema(() => z.string().check(z.minLength(1)));
const identity = lazyZodSchema(() => z.strictObject({ skillId }));
const createResult = lazyZodSchema(() => z.strictObject({ ok: z.literal(true), skillId, revision: SkillRevisionV1Schema,
  summary: z.optional(z.strictObject({ name: z.string().check(z.minLength(1)), description: z.nullable(z.string()), creator: z.optional(ArtifactSavedByV1Schema) })),
  // Older observation projections persisted only identity; absence makes no inclusion claim.
  includedInSessionId: z.optional(z.nullable(z.string())), incomplete: z.optional(z.enum(['rules', 'session_include'])) }));
const batchCreateResult = lazyZodSchema(() => z.strictObject({ skillIds: z.array(skillId), includedInSessionId: z.nullable(z.string()),
  incomplete: z.optional(z.array(z.strictObject({ skillId, step: z.enum(['rules', 'session_include']) }))) }));
export const SkillInstallPreviewV1Schema = lazyZodSchema(() => z.strictObject({ path: z.string(), name: z.string(), description: z.nullable(z.string()),
  files: z.array(SkillFileInputV1Schema), trust: SkillTrustV1Schema, cost: SkillCostV1Schema, provenance: SkillProvenanceV1Schema,
  /** Existing library identity: Add opens/reuses it rather than creating another skill. */
  inLibrary: z.optional(skillId),
  /** Advisory: relative files `SKILL.md` points at that this bundle will not contain; absent when there are none. */
  outsideReferences: z.optional(z.array(z.string())),
  /** Other previewed skills (by `path`) of the same source tree that `SKILL.md` refers to, with the `outsideReferences` each one covers; absent when there are none. */
  siblingSkills: z.optional(z.array(z.strictObject({ path: z.string(), references: z.array(z.string()) }))) }));
export type SkillInstallPreviewV1 = z.infer<typeof SkillInstallPreviewV1Schema>;
export const SkillInstallSourceV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RegistryItemPointerV1Schema, { kind: z.literal('registry') })),
  z.strictObject({ kind: z.literal('link'), url: z.string().check(z.url()),
    /** The exact skill trees returned by the reviewed preview, including multi-repository links. */
    refs: z.optional(z.array(RegistrySkillContentRefV1Schema)) }),
  z.strictObject({ kind: z.literal('upload'), files: z.array(SkillFileInputV1Schema) }),
]));
const changeResult = lazyZodSchema(() => z.strictObject({ revision: SkillRevisionV1Schema }));
export const SkillUpdateFileV1Schema = lazyZodSchema(() => z.strictObject({ path: z.string(), mine: z.nullable(SkillFileInputV1Schema),
  theirs: z.nullable(SkillFileInputV1Schema), changed: z.boolean(), base: z.optional(z.nullable(SkillFileInputV1Schema)), comparison: z.optional(ThreeWayTextComparisonV1Schema) }));
export type SkillUpdateFileV1 = z.infer<typeof SkillUpdateFileV1Schema>;
export const SKILL_ACTION_INPUT_SCHEMAS_V1 = {
  'skills.list': lazyZodSchema(() => z.strictObject({ skillIds: z.optional(z.array(skillId)), query: z.optional(z.string()), state: z.optional(z.enum(['in_use', 'off', 'updates', 'needs_attention'])) })),
  'skills.create': lazyZodSchema(() => z.strictObject({ name: z.string().check(z.minLength(1)), description: z.optional(z.string()), files: z.array(SkillFileInputV1Schema), where: z.optional(ReachRulesChangeV1Schema) })),
  'skills.update': lazyZodSchema(() => z.strictObject({ skillId, expectedRevision: SkillRevisionV1Schema, name: z.optional(z.string()), description: z.optional(z.string()), files: z.optional(z.array(SkillFileChangeV1Schema)), updatePolicy: z.optional(z.enum(['manual', 'auto', 'pinned'])) })),
  'skills.duplicate': identity,
  'skills.delete': lazyZodSchema(() => z.strictObject({ skillId, expectedRevision: SkillRevisionV1Schema })),
  'skills.install': lazyZodSchema(() => z.strictObject({ source: SkillInstallSourceV1Schema, selectPaths: z.optional(z.array(z.string())), where: z.optional(ReachRulesChangeV1Schema), dryRun: z.optional(z.boolean()) })),
  'skills.found.adopt': lazyZodSchema(() => z.strictObject({ machineId: z.string().check(z.minLength(1)),
    items: z.array(z.strictObject({ name: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)) })).check(z.minLength(1)), where: z.optional(ReachRulesChangeV1Schema) })),
  'skills.found.read': lazyZodSchema(() => z.strictObject({ machineId: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)) })),
  'skills.export': lazyZodSchema(() => z.strictObject({ skillIds: z.array(skillId).check(z.minLength(1)) })),
  'skills.updates.diff': lazyZodSchema(() => z.strictObject({ skillId, candidate: z.optional(SkillUpdateCandidateV1Schema) })),
  'skills.updates.apply': lazyZodSchema(() => z.strictObject({ skillId, expectedRevision: SkillRevisionV1Schema, candidate: z.optional(SkillUpdateCandidateV1Schema),
    choices: z.optional(z.record(z.string(), SkillUpdateChoiceV1Schema)), hunkChoices: z.optional(z.record(z.string(), z.record(z.string(), SkillUpdateChoiceV1Schema))) })),
} as const;
export const SKILL_ACTION_OUTPUT_SCHEMAS_V1 = {
  'skills.list': lazyZodSchema(() => z.strictObject({ items: z.array(SkillListItemV1Schema), revision: z.string(),
    unavailableItems: z.optional(z.array(SkillUnavailableItemV1Schema)),
    usageObservedSince: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative(), z.int()))) })),
  'skills.create': createResult, 'skills.update': changeResult, 'skills.duplicate': createResult,
  'skills.delete': lazyZodSchema(() => z.strictObject({ deleted: z.literal(true), rulesLeft: z.optional(z.literal(true)) })),
  'skills.install': lazyZodSchema(() => z.union([
    z.strictObject({ items: z.array(SkillInstallPreviewV1Schema) }),
    batchCreateResult,
  ])),
  'skills.found.adopt': batchCreateResult,
  'skills.found.read': lazyZodSchema(() => z.strictObject({ name: z.string().check(z.minLength(1)), files: z.array(SkillFileInputV1Schema) })),
  'skills.export': lazyZodSchema(() => z.strictObject({ fileName: z.string(), bytes: z.string() })),
  'skills.updates.diff': lazyZodSchema(() => z.strictObject({ files: z.array(SkillUpdateFileV1Schema), revision: z.optional(SkillRevisionV1Schema), costDelta: z.strictObject({ mine: SkillCostV1Schema, theirs: SkillCostV1Schema }) })),
  'skills.updates.apply': lazyZodSchema(() => z.strictObject({ revision: SkillRevisionV1Schema, provenance: SkillProvenanceV1Schema })),
} as const;
export type SkillLibraryActionIdV1 = keyof typeof SKILL_ACTION_INPUT_SCHEMAS_V1;
export type SkillLibraryActionInputByIdV1 = { readonly [K in SkillLibraryActionIdV1]: z.infer<(typeof SKILL_ACTION_INPUT_SCHEMAS_V1)[K]> };
export type SkillLibraryActionResultByIdV1 = { readonly [K in SkillLibraryActionIdV1]: z.infer<(typeof SKILL_ACTION_OUTPUT_SCHEMAS_V1)[K]> };

export const SkillFoundListInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)), directory: z.optional(z.string().check(z.minLength(1))),
}));
export const SkillFoundListResultV1Schema = lazyZodSchema(() => z.strictObject({
  scannedAt: z.number().check(z.int(), z.minimum(0)),
  roots: z.array(z.strictObject({
    path: z.string().check(z.minLength(1)), scope: z.enum(['user', 'project', 'plugin']),
    agents: z.array(AgentIdV1Schema), status: z.enum(['ok', 'failed']),
  })),
  items: z.array(z.strictObject({
    name: z.string().check(z.minLength(1)), description: z.nullable(z.string()),
    userInvocable: z.optional(z.boolean()),
    // Found and download both identify the skill directory, never its SKILL.md.
    path: z.string().check(z.minLength(1)), digest: z.string().check(z.minLength(1)), agents: z.array(AgentIdV1Schema),
    scope: z.enum(['user', 'project', 'plugin']), inLibrary: z.nullable(skillId),
    masksLibrary: z.boolean(), happierInstalled: z.boolean(),
    pluginOwned: z.nullable(z.strictObject({ pluginName: z.string().check(z.minLength(1)) })),
  })),
}));
export type SkillFoundListInputV1 = z.infer<typeof SkillFoundListInputV1Schema>;
export type SkillFoundListResultV1 = z.infer<typeof SkillFoundListResultV1Schema>;

export const SkillMachineInstallInputV1Schema = lazyZodSchema(() => z.strictObject({
  skillId, machineId: z.string().check(z.minLength(1)), agents: z.optional(z.array(AgentIdV1Schema)),
}));
export const SkillMachineInstallResultV1Schema = lazyZodSchema(() => z.strictObject({
  receipts: z.array(z.strictObject({ root: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), digest: z.string().check(z.minLength(1)) })),
}));
export type SkillMachineInstallInputV1 = z.infer<typeof SkillMachineInstallInputV1Schema>;
export type SkillMachineInstallResultV1 = z.infer<typeof SkillMachineInstallResultV1Schema>;
export const SkillMachineUninstallInputV1Schema = lazyZodSchema(() => z.strictObject({
  skillId, machineId: z.string().check(z.minLength(1)), force: z.optional(z.boolean()),
}));
export const SkillMachineUninstallResultV1Schema = lazyZodSchema(() => z.strictObject({ removed: z.array(z.string().check(z.minLength(1))) }));
export type SkillMachineUninstallInputV1 = z.infer<typeof SkillMachineUninstallInputV1Schema>;
export type SkillMachineUninstallResultV1 = z.infer<typeof SkillMachineUninstallResultV1Schema>;

// Machine handlers consume these shapes; the Account library dispatcher stays closed.
export const SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1 = {
  'skills.found.list': SkillFoundListInputV1Schema,
  'skills.machine.install': SkillMachineInstallInputV1Schema,
  'skills.machine.uninstall': SkillMachineUninstallInputV1Schema,
} as const;
export const SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1 = {
  'skills.found.list': SkillFoundListResultV1Schema,
  'skills.machine.install': SkillMachineInstallResultV1Schema,
  'skills.machine.uninstall': SkillMachineUninstallResultV1Schema,
} as const;
export type SkillMachineActionIdV1 = keyof typeof SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1;
export type SkillMachineActionInputByIdV1 = { readonly [K in SkillMachineActionIdV1]: z.infer<(typeof SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1)[K]> };
export type SkillMachineActionResultByIdV1 = { readonly [K in SkillMachineActionIdV1]: z.infer<(typeof SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1)[K]> };

/** Actual content acknowledgements carried by the existing outer Action failure envelope. */
export const SkillInstallAcknowledgedEffectsV1Schema = lazyZodSchema(() => z.strictObject({
  skillIds: z.array(skillId),
  incomplete: z.array(z.strictObject({ skillId, step: z.enum(['rules', 'session_include']) })),
}));
export type SkillInstallAcknowledgedEffectsV1 = z.infer<typeof SkillInstallAcknowledgedEffectsV1Schema>;

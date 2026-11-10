import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { RoleArtifactV1Schema, RoleEngineV1Schema, RoleRunsAsV1Schema } from './roleArtifactV1.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

export const RoleOverrideV1Schema = lazyZodSchema(() => z.strictObject({
  roleId: z.string().check(z.minLength(1)),
  engine: z.optional(RoleEngineV1Schema),
  runsAs: z.optional(RoleRunsAsV1Schema),
  profileId: z.optional(z.string().check(z.minLength(1))),
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  secondOpinion: z.optional(z.enum(['off', 'encouraged'])),
  canDelegateToOtherRoles: z.optional(z.boolean()),
}));
export type RoleOverrideV1 = z.infer<typeof RoleOverrideV1Schema>;
export const RoleInstructionsOverrideV1Schema = lazyZodSchema(() => z.extend(RoleOverrideV1Schema, { instructionsOverride: z.optional(z.string()) }));
export type RoleInstructionsOverrideV1 = z.infer<typeof RoleInstructionsOverrideV1Schema>;

const InlineWorkflowRoleV1Schema = lazyZodSchema(() => z.extend(RoleOverrideV1Schema, { name: z.string().check(z.minLength(1)), instructions: z.string(), runsAs: RoleRunsAsV1Schema }));
export const WorkflowRoleV1Schema = defineStoredReadProjection(z.union([
  RoleOverrideV1Schema,
  InlineWorkflowRoleV1Schema,
]), () => z.union([
  createStoredReadSchema(InlineWorkflowRoleV1Schema),
  // Inline fields identify that arm even when invalid; stripping must not
  // silently turn an authored role into a reference-only override.
  (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value !== null && typeof value === 'object'
    && ('name' in value || 'instructions' in value) ? null : value), createStoredReadSchema(RoleOverrideV1Schema)),
]));
export type WorkflowRoleV1 = z.infer<typeof WorkflowRoleV1Schema>;

export const RoleResolutionLayerV1Schema = lazyZodSchema(() => z.enum(['run', 'workflow', 'session', 'settings']));
export type RoleResolutionLayerV1 = z.infer<typeof RoleResolutionLayerV1Schema>;
export const ResolvedRoleV1Schema = lazyZodSchema(() => z.extend(RoleArtifactV1Schema, {
  roleId: z.string().check(z.minLength(1)),
  changedAt: z.optional(RoleResolutionLayerV1Schema),
  profileUnavailable: z.optional(z.boolean()),
}));
export type ResolvedRoleV1 = z.infer<typeof ResolvedRoleV1Schema>;
export const ResolvedRolesSnapshotV1Schema = lazyZodSchema(() => z.record(z.string().check(z.minLength(1)), ResolvedRoleV1Schema));
export type ResolvedRolesSnapshotV1 = z.infer<typeof ResolvedRolesSnapshotV1Schema>;

/** Read-only PEP projection, not a second plugin manifest or catalog. */
export type PluginRoleContributionV1 = Readonly<{
  pluginId: string;
  pluginDisplayName?: string;
  localId: string;
  role: z.infer<typeof RoleArtifactV1Schema>;
}>;

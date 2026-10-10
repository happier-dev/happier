import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { RoleArtifactV1Schema, RoleEngineV1Schema, RoleRunsAsV1Schema } from './roleArtifactV1.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

export const RoleOverrideV1Schema = lazyZodSchema(() => z.object({
  roleId: z.string().min(1),
  engine: RoleEngineV1Schema.optional(),
  runsAs: RoleRunsAsV1Schema.optional(),
  profileId: z.string().min(1).optional(),
  workspaceWrites: z.enum(['allow', 'deny']).optional(),
  secondOpinion: z.enum(['off', 'encouraged']).optional(),
}).strict());
export type RoleOverrideV1 = z.infer<typeof RoleOverrideV1Schema>;
export const RoleInstructionsOverrideV1Schema = lazyZodSchema(() => RoleOverrideV1Schema.extend({ instructionsOverride: z.string().optional() }));
export type RoleInstructionsOverrideV1 = z.infer<typeof RoleInstructionsOverrideV1Schema>;

const InlineWorkflowRoleV1Schema = lazyZodSchema(() => RoleOverrideV1Schema.extend({ name: z.string().min(1), instructions: z.string(), runsAs: RoleRunsAsV1Schema }));
export const WorkflowRoleV1Schema = defineStoredReadProjection(z.union([
  RoleOverrideV1Schema,
  InlineWorkflowRoleV1Schema,
]), () => z.union([
  createStoredReadSchema(InlineWorkflowRoleV1Schema),
  // Inline fields identify that arm even when invalid; stripping must not
  // silently turn an authored role into a reference-only override.
  z.preprocess((value) => value !== null && typeof value === 'object'
    && ('name' in value || 'instructions' in value) ? null : value, createStoredReadSchema(RoleOverrideV1Schema)),
]));
export type WorkflowRoleV1 = z.infer<typeof WorkflowRoleV1Schema>;

export const RoleResolutionLayerV1Schema = lazyZodSchema(() => z.enum(['run', 'workflow', 'session', 'settings']));
export type RoleResolutionLayerV1 = z.infer<typeof RoleResolutionLayerV1Schema>;
export const ResolvedRoleV1Schema = lazyZodSchema(() => RoleArtifactV1Schema.extend({
  roleId: z.string().min(1),
  changedAt: RoleResolutionLayerV1Schema.optional(),
  profileUnavailable: z.boolean().optional(),
}));
export type ResolvedRoleV1 = z.infer<typeof ResolvedRoleV1Schema>;
export const ResolvedRolesSnapshotV1Schema = lazyZodSchema(() => z.record(z.string().min(1), ResolvedRoleV1Schema));
export type ResolvedRolesSnapshotV1 = z.infer<typeof ResolvedRolesSnapshotV1Schema>;

/** Read-only PEP projection, not a second plugin manifest or catalog. */
export type PluginRoleContributionV1 = Readonly<{
  pluginId: string;
  pluginDisplayName?: string;
  localId: string;
  role: z.infer<typeof RoleArtifactV1Schema>;
}>;

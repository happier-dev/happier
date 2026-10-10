import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ExecutionRunIntentSchema } from '../../execution/runs/runPrimitives.js';
import { ProviderAgentTargetKeySchema, ProviderModelIdSchema } from '../../providers/ids.js';

/** Role V1 is an executable declaration: every object boundary is closed. */
export const RoleEngineV1Schema = lazyZodSchema(() => z.object({
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema.optional(),
  effort: z.string().min(1).optional(),
}).strict());
export type RoleEngineV1 = z.infer<typeof RoleEngineV1Schema>;

export const RoleRunsAsV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session') }).strict(),
  z.object({ kind: z.literal('background_run'), intent: ExecutionRunIntentSchema }).strict(),
]));
export type RoleRunsAsV1 = z.infer<typeof RoleRunsAsV1Schema>;

/** All role editors use the task profile when a session role becomes a background run. */
export const DEFAULT_ROLE_BACKGROUND_INTENT_V1 = 'task' as const;

export function resolveRoleRunsAsKindV1(kind: RoleRunsAsV1['kind'], current?: RoleRunsAsV1): RoleRunsAsV1 {
  return kind === 'session' ? { kind: 'session' } : {
    kind: 'background_run',
    intent: current?.kind === 'background_run' ? current.intent : DEFAULT_ROLE_BACKGROUND_INTENT_V1,
  };
}

export const RoleArtifactV1Schema = lazyZodSchema(() => z.object({
  name: z.string().min(1),
  instructions: z.string(),
  engine: RoleEngineV1Schema.optional(),
  runsAs: RoleRunsAsV1Schema,
  profileId: z.string().min(1).optional(),
  workspaceWrites: z.enum(['allow', 'deny']),
  secondOpinion: z.enum(['off', 'encouraged']),
  enabled: z.boolean(),
}).strict());
export type RoleArtifactV1 = z.infer<typeof RoleArtifactV1Schema>;

/** Ordinary Role writers and restores share one body-derived header projection. */
export function buildRoleArtifactHeaderV1(role: RoleArtifactV1): Readonly<Record<string, unknown>> {
  return { kind: 'role.v1', name: role.name };
}

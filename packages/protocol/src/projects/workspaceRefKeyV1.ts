import * as z from '../zodRuntimePolicy.js';
import { lazyDefinition } from '../lazyZodSchema.js';

const IdSchema = lazyDefinition(() => z.string().check(z.minLength(1), z.refine(value => value === value.trim())));

export const ProjectAccountWorkspaceRefKeyV1Schema = lazyDefinition(() => z.strictObject({
  kind: z.literal('workspace-ref'), serverId: IdSchema, id: IdSchema,
}));
export type ProjectAccountWorkspaceRefKeyV1 = z.infer<typeof ProjectAccountWorkspaceRefKeyV1Schema>;

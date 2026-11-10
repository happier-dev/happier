import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { normalizeWorkspaceRootPathV1, isAbsoluteWorkspaceRootPathV1 } from '../workspaces/workspaceRefResolutionV1.js';

export const ReachPlaceV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('allMachines') }),
  z.strictObject({ t: z.literal('machine'), machineId: z.string().check(z.minLength(1)) }),
  z.strictObject({ t: z.literal('project'), projectKey: z.string().check(z.minLength(1)) }),
  z.strictObject({ t: z.literal('workspace'), machineId: z.string().check(z.minLength(1)), workspaceRoot: z.string().check(z.minLength(1), z.refine(isAbsoluteWorkspaceRootPathV1, 'workspaceRoot must be an absolute path')) }),
]));
export type ReachPlaceV1 = z.infer<typeof ReachPlaceV1Schema>;

/** The stored spelling survives; equality uses the canonical comparison owner. */
export function reachPlaceKeyV1(target: ReachPlaceV1): string {
  if (target.t === 'allMachines') return JSON.stringify([target.t]);
  if (target.t === 'project') return JSON.stringify([target.t, target.projectKey]);
  if (target.t === 'machine') return JSON.stringify([target.t, target.machineId]);
  return JSON.stringify([target.t, target.machineId, normalizeWorkspaceRootPathV1(target.workspaceRoot)]);
}

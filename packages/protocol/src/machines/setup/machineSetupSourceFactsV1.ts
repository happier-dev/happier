import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { StoredAppPresetInputV1Schema, type StoredAppPresetInputV1 } from '../../deployments/storedAppInputV1.js';
import { WorkflowRunIdV1Schema } from '../../workflows/workflowIdsV1.js';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
export type MachineSetupFirstPresenceV1 = 'present' | 'absent';
/** Address only: authenticated Run progress, never native settlement, proves app completion. */
export type MachineSetupAcceptedAppRunV1 = Readonly<{
  intent: StoredAppPresetInputV1;
  authoredKey?: string | undefined;
  homeId: string;
  runId: string;
  sourceKey: string;
  blockId: string;
  actionId: typeof DEPLOYMENT_DEPLOY_ACTION_ID_V1 | typeof DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1;
}>;
export type MachineSetupSourceFactsMapV1 = Record<string, Readonly<{
  firstPresence?: Record<string, MachineSetupFirstPresenceV1> | undefined;
  acceptedAppRuns?: MachineSetupAcceptedAppRunV1[] | undefined;
  /** Unfinished original script indices after a confirmed partial Apply. */
  pendingScripts?: number[] | undefined;
}>>;
/** Native target facts belong to this target, never to Home-certified copies. */
export const MachineSetupSourceFactsMapV1Schema: z.ZodMiniType<MachineSetupSourceFactsMapV1> = lazyZodSchema(() => z.record(id(), z.strictObject({
  firstPresence: z.optional(z.record(id(), z.enum(['present', 'absent']))),
  pendingScripts: z.optional(z.array(revision())),
  acceptedAppRuns: z.optional(z.array(z.strictObject({
    intent: StoredAppPresetInputV1Schema, authoredKey: z.optional(id()), homeId: id(), runId: WorkflowRunIdV1Schema,
    sourceKey: id(), blockId: id(), actionId: z.enum([DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1]),
  }))),
})));

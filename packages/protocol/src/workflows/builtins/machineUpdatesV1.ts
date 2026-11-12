import type { MachineSetupUpdatesRolloutInputV1 } from '../../machines/managed/actionsV1.js';
import { MACHINE_SETUP_UPDATES_APPLY_ACTION_ID_V1, MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1,
  MACHINE_SETUP_PLAN_ACTION_ID_V1 } from '../../machines/managed/actionIdsV1.js';
import { MACHINE_REBOOT_ACTION_IDS } from '../../machines/rebootActionIdsV1.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import type { WorkflowActionLeafV1, WorkflowBlock, WorkflowDefinitionV1 } from '../workflowV1.js';
import { literal, result } from './definitionParts.js';

function action(id: string, actionId: WorkflowActionLeafV1['actionId'], input: object): WorkflowActionLeafV1 {
  return { kind: 'action', id, actionId, input: Object.fromEntries(Object.entries(input)
    .map(([key, value]) => [key, literal(projectNativeJsonValueForTransport(value))])) };
}

/** Exact reviewed operands; the existing coordinator owns parallelism, settlement and recovery. */
export function createMachineUpdatesRolloutWorkflowV1(input: MachineSetupUpdatesRolloutInputV1): WorkflowDefinitionV1 {
  return { version: 1, defaults: {}, inputs: [], blocks: input.batches.map((batch, batchIndex) => ({
    kind: 'parallel', id: `batch-${batchIndex}`, failurePolicy: input.failurePolicy,
    branches: batch.map((target, targetIndex) => {
      const { reboot, ...updates } = target;
      const suffix = `${batchIndex}-${targetIndex}`;
      const blocks: WorkflowBlock[] = [action(`update-${suffix}`, MACHINE_SETUP_UPDATES_APPLY_ACTION_ID_V1, updates)];
      if (reboot) {
        const observation = `observe-${suffix}`;
        blocks.push(action(observation, MACHINE_SETUP_PLAN_ACTION_ID_V1, { homeId: target.homeId, machineId: target.machineId,
          mode: 'check', updates: { scope: target.scope } }), {
          kind: 'if', id: `needs-reboot-${suffix}`, when: { kind: 'all', conditions: [
            { kind: 'exists', value: result(observation, ['updates', 'observation', 'rebootNeeded']) },
            { kind: 'compare', operator: 'eq',
              left: result(observation, ['updates', 'observation', 'rebootNeeded']), right: literal(true) },
          ] },
          then: [action(`reboot-${suffix}`, MACHINE_REBOOT_ACTION_IDS[0], { serverId: target.homeId,
            machineId: target.machineId, expectedInstallationId: reboot.expectedInstallationId })], otherwise: [],
        });
      }
      return { id: `machine-${suffix}`, blocks };
    }),
  })) };
}

/** Existing Trigger Actions schedule one reviewed rollout; each occurrence admits its targets together. */
export function createScheduledMachineUpdatesRolloutWorkflowV1(input: MachineSetupUpdatesRolloutInputV1): WorkflowDefinitionV1 {
  return { version: 1, defaults: {}, inputs: [], blocks: [action('rollout', MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1, input)] };
}

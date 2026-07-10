import {
  ACTION_ID_FAMILIES_V1,
  type RuntimeActionIdV1,
} from '../actionIds.js';
import type { RuntimeActionDispatchArgs } from './types.js';

export const DEVICES_SIMULATOR_RUNTIME_ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.devices_simulator,
] as const satisfies readonly RuntimeActionIdV1[];

export type DevicesSimulatorRuntimeActionId = (typeof DEVICES_SIMULATOR_RUNTIME_ACTION_IDS)[number];

const DEVICES_SIMULATOR_RUNTIME_ACTION_ID_SET: ReadonlySet<RuntimeActionIdV1> = new Set(
  DEVICES_SIMULATOR_RUNTIME_ACTION_IDS,
);

export function isDevicesSimulatorRuntimeActionId(actionId: RuntimeActionIdV1): actionId is DevicesSimulatorRuntimeActionId {
  return DEVICES_SIMULATOR_RUNTIME_ACTION_ID_SET.has(actionId);
}

export async function executeDevicesSimulatorRuntimeAction(args: RuntimeActionDispatchArgs<DevicesSimulatorRuntimeActionId>): Promise<unknown> {
  return args.runtimeActionExecute({
    actionId: args.actionId,
    input: args.input,
    context: args.context,
  });
}

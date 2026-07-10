import {
  ACTION_ID_FAMILIES_V1,
  type RuntimeActionIdV1,
} from '../actionIds.js';
import type { RuntimeActionDispatchArgs } from './types.js';

export const LOCAL_SERVICES_RUNTIME_ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.local_services_inventory,
  ...ACTION_ID_FAMILIES_V1.local_services_launcher,
  ...ACTION_ID_FAMILIES_V1.local_services_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
  ...ACTION_ID_FAMILIES_V1.local_services_actions,
] as const satisfies readonly RuntimeActionIdV1[];

export type LocalServicesRuntimeActionId = (typeof LOCAL_SERVICES_RUNTIME_ACTION_IDS)[number];

const LOCAL_SERVICES_RUNTIME_ACTION_ID_SET: ReadonlySet<RuntimeActionIdV1> = new Set(
  LOCAL_SERVICES_RUNTIME_ACTION_IDS,
);

export function isLocalServicesRuntimeActionId(actionId: RuntimeActionIdV1): actionId is LocalServicesRuntimeActionId {
  return LOCAL_SERVICES_RUNTIME_ACTION_ID_SET.has(actionId);
}

export async function executeLocalServicesRuntimeAction(args: RuntimeActionDispatchArgs<LocalServicesRuntimeActionId>): Promise<unknown> {
  return args.runtimeActionExecute({
    actionId: args.actionId,
    input: args.input,
    context: args.context,
  });
}

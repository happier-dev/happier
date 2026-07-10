import {
  ACTION_ID_FAMILIES_V1,
  type RuntimeActionIdV1,
} from '../actionIds.js';
import type { RuntimeActionDispatchArgs } from './types.js';

export const PEER_MEDIATION_RUNTIME_ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.peer_mediation_observability,
] as const satisfies readonly RuntimeActionIdV1[];

export type PeerMediationRuntimeActionId = (typeof PEER_MEDIATION_RUNTIME_ACTION_IDS)[number];

const PEER_MEDIATION_RUNTIME_ACTION_ID_SET: ReadonlySet<RuntimeActionIdV1> = new Set(
  PEER_MEDIATION_RUNTIME_ACTION_IDS,
);

export function isPeerMediationRuntimeActionId(actionId: RuntimeActionIdV1): actionId is PeerMediationRuntimeActionId {
  return PEER_MEDIATION_RUNTIME_ACTION_ID_SET.has(actionId);
}

export async function executePeerMediationRuntimeAction(args: RuntimeActionDispatchArgs<PeerMediationRuntimeActionId>): Promise<unknown> {
  return args.runtimeActionExecute({
    actionId: args.actionId,
    input: args.input,
    context: args.context,
  });
}

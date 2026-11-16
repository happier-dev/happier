import {
  buildMachineSetupTargetApplyInput as canonicalBuildMachineSetupTargetApplyInput,
  machineSetupApplyTargetFromPlanV1 as canonicalMachineSetupApplyTargetFromPlanV1,
  waitForMachineSetupOperationV1 as canonicalWaitForMachineSetupOperationV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import type { PluginActionInputById, PluginActionResultById } from './actionTypeMap.generated.js';
import type { ActionExecuteResult } from './dtos/pluginActionDtoSupport.generated.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';

/** Public source copies are the canonical target Plan's accepted source contract. */
export type MachineSetupSourceV1 = Extract<PluginActionResultById['machines.setup.plan'], { sources: unknown }>['sources'];
export type MachineSetupSourceEntryV1 = MachineSetupSourceV1[number];

type SetupPlan = Extract<PluginActionResultById['machines.setup.plan'], { sources: unknown }>;
type SetupApplyInput = PluginActionInputById['machines.setup.apply'];
type SetupApplyTarget = SetupApplyInput['targets'][number];

/** Retains executable Plan fields while omitting presentation facts. */
export const machineSetupApplyTargetFromPlanV1: (
  target: Pick<SetupApplyTarget, 'homeId' | 'machineId'>,
  plan: SetupPlan,
) => SetupApplyTarget = /* @__PURE__ */ projectProtocolValue(canonicalMachineSetupApplyTargetFromPlanV1);

/** Builds the ordinary Apply operand through the Protocol owner. */
export const buildMachineSetupTargetApplyInput: (
  target: SetupApplyTarget,
) => SetupApplyInput = /* @__PURE__ */ projectProtocolValue(canonicalBuildMachineSetupTargetApplyInput);

/** Joins the retained setup operation through the caller's ordinary Action transport. */
export const waitForMachineSetupOperationV1: (
  operationId: string,
  observe: (request: Pick<PluginActionInputById['action.operations.get'], 'operationId' | 'waitForTerminal'>) => Promise<unknown>,
) => Promise<Extract<ActionExecuteResult, { ok: false }> | null> = /* @__PURE__ */ projectProtocolValue(canonicalWaitForMachineSetupOperationV1);

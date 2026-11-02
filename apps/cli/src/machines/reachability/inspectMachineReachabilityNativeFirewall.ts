import { createMachineFirewallTransitionObservationStepV1, readMachineFirewallTransitionFactsV1 } from '@happier-dev/cli-common/machineSetup';
import type { MachineSetupEffectPlanV1, MachineFirewallTransitionFactsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { checkElevatedMachineSetupPlanResult, type MachineElevationDependencies } from '../adminAccess/runElevatedEffect';

/** Read the native owner's protected facts through its existing root CHECK.
 * No posture, APPLY frame, interactive elevation or native admission is needed. */
export async function inspectMachineReachabilityNativeFirewall(input: Readonly<{
  machineId: string; requestId: string; signal?: AbortSignal;
  basis: MachineSetupEffectPlanV1['basis'];
}>, elevation: MachineElevationDependencies): Promise<ActionExecuteFailure | Readonly<{ ok: true; facts: MachineFirewallTransitionFactsV1 }>> {
  const step = createMachineFirewallTransitionObservationStepV1({ caddy: {} });
  const result = await checkElevatedMachineSetupPlanResult({ machineId: input.machineId,
    operationId: input.requestId, signal: input.signal, basis: input.basis, steps: [step] }, elevation);
  if (result.outcome !== 'checked') {
    const code = result.outcome === 'not_applied' ? result.reasonCode : 'machine_recipe_native_unavailable';
    return { ok: false as const, errorCode: code, error: code,
      ...('recovery' in result && result.recovery ? { details: { recovery: result.recovery } } : {}) };
  }
  const observation = result.plan.nativeFacts.find(fact => fact.stepId === step.id);
  return { ok: true as const, facts: observation ? readMachineFirewallTransitionFactsV1(observation)
    : { status: 'unavailable' as const, requiredFact: 'nativeFirewall' } };
}

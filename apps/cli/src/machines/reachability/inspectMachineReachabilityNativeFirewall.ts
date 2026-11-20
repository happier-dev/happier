import { createMachineFirewallTransitionObservationStepV1, readMachineFirewallTransitionFactsV1 } from '@happier-dev/cli-common/machineSetup';
import type { MachineSetupEffectPlanV1, MachineFirewallTransitionFactsV1, MachineFirewallTransitionIntentV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineElevationDependencies } from '../adminAccess/runElevatedEffect';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { readProtectedMachineFirewall } from '../setup/readProtectedMachineFirewall';

/** Read the native owner's protected facts through its existing root CHECK.
 * No posture, APPLY frame or native admission is needed; Ask uses the elevation owner’s password prompt. */
export async function inspectMachineReachabilityNativeFirewall(input: Readonly<{
  machineId: string; requestId: string; signal?: AbortSignal;
  basis: MachineSetupEffectPlanV1['basis'];
  caddy?: MachineFirewallTransitionIntentV1['caddy'];
  caddyObservation?: Readonly<{ privateNetworks: readonly MachinePrivateNetworkObservationV1[] }>;
}>, elevation: MachineElevationDependencies): Promise<ActionExecuteFailure | Readonly<{ ok: true; facts: MachineFirewallTransitionFactsV1 }>> {
  const step = createMachineFirewallTransitionObservationStepV1({ caddy: input.caddy ?? {},
    ...(input.caddyObservation ? { caddyObservation: { privateNetworks: [...input.caddyObservation.privateNetworks] } } : {}) });
  const result = await readProtectedMachineFirewall({ ...input, step }, elevation);
  if (result.outcome !== 'checked') {
    const code = result.outcome === 'not_applied' ? result.reasonCode
      : result.outcome === 'needs_attendance' ? 'machine_admin_access_required' : 'machine_recipe_native_unavailable';
    const failure = 'failure' in result ? result.failure : undefined;
    const recovery = 'recovery' in result ? result.recovery : undefined;
    return { ok: false as const, errorCode: code, error: code,
      ...(failure ? { details: { failure, ...(failure.remedy ? { remedy: failure.remedy } : {}),
        ...(recovery ? { recovery } : {}) } }
        : result.outcome === 'needs_attendance' ? { details: { elevation: result } }
        : recovery ? { details: { recovery } } : {}) };
  }
  const observation = result.plan.nativeFacts.find(fact => fact.stepId === step.id);
  const facts = readMachineFirewallTransitionFactsV1(observation);
  if (facts.caddy?.status === 'unavailable') return { ok: false, errorCode: facts.caddy.reason,
    error: facts.caddy.reason, effectAttempted: false, ...(facts.caddy.details ? { details: facts.caddy.details } : {}) };
  if (input.caddyObservation && facts.status === 'available' && facts.caddy?.status !== 'ready') return {
    ok: false, errorCode: 'native_protocol_invalid', error: 'native_protocol_invalid', effectAttempted: false,
    details: { failure: { kind: 'native_protocol_invalid', phase: 'check', requiredFact: 'caddyFirewall' },
      remedy: 'Update the Machine CLI and retry Network review to obtain its protected Caddy observation.' } };

  return { ok: true, facts };
}

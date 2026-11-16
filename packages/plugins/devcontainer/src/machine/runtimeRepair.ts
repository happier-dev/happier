import { dockerEngineAccessModeInputSchema, DOCKER_ENGINE_RECIPE_REF_V1, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { buildMachineSetupTargetApplyInput, isPluginActionApprovalRequestCreated, machineSetupApplyTargetFromPlanV1, waitForMachineSetupOperationV1, type MachineSetupSourceV1 } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';

export const DockerRuntimeRepairInputSchema = { type: 'object', properties: { mode: dockerEngineAccessModeInputSchema },
  additionalProperties: false } as const;
export type DockerRuntimeRepairInput = Readonly<{ mode?: typeof dockerEngineAccessModeInputSchema.enum[number] }>;

export function dockerRuntimeRepairSources(input: DockerRuntimeRepairInput = {}) {
  return [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
    ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: { mode: input.mode ?? dockerEngineAccessModeInputSchema.default, daemonConfig: {} },
  } }] } }] satisfies MachineSetupSourceV1;
}

/** Installation, support, administrator consent and operation lifetime stay
 * with the Machine setup owner; the provider only selects its existing recipe. */
export async function installDockerRuntime(context: PluginInvocationContext, input: DockerRuntimeRepairInput = {}) {
  const routing = await context.services.actions.getCurrentExecutionRouting?.({ signal: context.signal });
  if (!routing) throw new PluginError({ code: 'target_unavailable', message: 'The container controller is unavailable.' });
  const target = { homeId: routing.serverIdentityId, machineId: routing.machineId };
  const plan = await context.services.actions.execute('machines.setup.plan', { ...target,
    sources: dockerRuntimeRepairSources(input),
  }, { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(plan)) return plan;
  // This request addresses one controller, whose Plan contract is not the
  // combined multi-target presentation returned by an aggregate request.
  if (!('sources' in plan)) throw new PluginError({ code: 'machine_setup_response_invalid' });
  const applied = await context.services.actions.execute('machines.setup.apply',
    buildMachineSetupTargetApplyInput(machineSetupApplyTargetFromPlanV1(target, plan)), { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(applied)) return applied;
  const failure = await waitForMachineSetupOperationV1(applied.operationId, request => context.services.actions.execute('action.operations.get',
    { serverId: target.homeId, machineId: target.machineId, ...request }, { signal: context.signal }));
  if (failure) {
    const details = defineProtocolJsonValue().safeParse(failure.details);
    throw new PluginError({ code: failure.errorCode, message: failure.error,
      ...(failure.failureCause ? { failureCause: failure.failureCause } : {}),
      ...(details.success ? { details: details.data } : {}) });
  }
  return applied;
}

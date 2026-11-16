import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { buildMachineSetupTargetApplyInput, isPluginActionApprovalRequestCreated, machineSetupApplyTargetFromPlanV1,
  waitForMachineSetupOperationV1, type MachineSetupSourceV1 } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { DOCKER_SANDBOXES_PLUGIN_ID } from './provider.js';

export function dockerSandboxesInstallSources() {
  return [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
    ref: { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, recipeId: 'docker-sandboxes-install', revision: '1' }, inputs: {},
  } }] } }] satisfies MachineSetupSourceV1;
}

/** Setup owns native platform support, approval and installation lifetime. */
export async function installDockerSandboxes(context: PluginInvocationContext) {
  const routing = await context.services.actions.getCurrentExecutionRouting?.({ signal: context.signal });
  if (!routing) throw new PluginError({ code: 'target_unavailable', message: 'The sandbox controller is unavailable.' });
  const target = { homeId: routing.serverIdentityId, machineId: routing.machineId };
  const plan = await context.services.actions.execute('machines.setup.plan', { ...target, sources: dockerSandboxesInstallSources() }, { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(plan)) return plan;
  if (!('sources' in plan)) throw new PluginError({ code: 'machine_setup_response_invalid' });
  const applied = await context.services.actions.execute('machines.setup.apply',
    buildMachineSetupTargetApplyInput(machineSetupApplyTargetFromPlanV1(target, plan)), { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(applied)) return applied;
  const failure = await waitForMachineSetupOperationV1(applied.operationId, request => context.services.actions.execute('action.operations.get',
    { serverId: target.homeId, machineId: target.machineId, ...request }, { signal: context.signal }));
  if (failure) {
    const details = defineProtocolJsonValue().safeParse(failure.details);
    throw new PluginError({ code: failure.errorCode, message: failure.error,
      ...(failure.failureCause ? { failureCause: failure.failureCause } : {}), ...(details.success ? { details: details.data } : {}) });
  }
  return applied;
}

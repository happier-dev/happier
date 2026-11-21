import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { isRecord, projectDeploymentTargetHttpFailureV1, settleDeploymentTargetResourceRemovalV1 } from '@happier-dev/plugin-sdk';
import { isMachineProvisionerCreateRefusal } from '@happier-dev/plugin-sdk/machine-provisioners';
import { RailwayNativeError } from '@happier-dev/railway-api';
import { engines, railway, readFailure, type Engine, type Selection, type ServiceSelection } from './provider.js';

function templateId(template: unknown): string {
  if (!isRecord(template) || typeof template.id !== 'string' || !template.id) {
    throw new PluginError({ code: 'provider_response_invalid' });
  }
  return template.id;
}

export async function provision(engine: Engine, selection: Selection & { workspaceId: string }, context: PluginAccountActionContext) {
  const { projectId, environmentId, workspaceId } = selection;
  const { query } = railway(context);
  const templateCode = engines[engine].template;
  const { template, project, environment } = await query(`query($projectId: String!, $environmentId: String!, $templateCode: String!) {
    template(code: $templateCode) { id serializedConfig }
    project(id: $projectId) { id workspaceId }
    environment(id: $environmentId, projectId: $projectId) { id projectId }
  }`, { projectId, environmentId, templateCode }).catch(readFailure);
  if (!isRecord(project) || project.id !== projectId || project.workspaceId !== workspaceId
    || !isRecord(environment) || environment.id !== environmentId || environment.projectId !== projectId) {
    throw new PluginError({ code: 'target_mismatch' });
  }
  if (!isRecord(template) || template.serializedConfig == null) throw new PluginError({ code: 'provider_response_invalid' });
  const input = { templateId: templateId(template), serializedConfig: template.serializedConfig,
    projectId, environmentId, workspaceId };
  const scope = { projectId, railwayEnvironmentId: environmentId, workspaceId };
  context.signal.throwIfAborted();
  try {
    const { templateDeployV2: receipt } = await query(`mutation($input: TemplateDeployV2Input!) {
      templateDeployV2(input: $input) { projectId workflowId }
    }`, { input });
    if (!isRecord(receipt) || receipt.projectId !== projectId || typeof receipt.workflowId !== 'string' || !receipt.workflowId) {
      return { status: 'outcome_unknown', ...scope };
    }
    return { status: 'adoption_required', workflowId: receipt.workflowId, ...scope };
  } catch (error) {
    context.signal.throwIfAborted();
    if (writeRefused(error)) return readFailure(error);
    const projected = projectDeploymentTargetHttpFailureV1(error, 'write', 'railway.data.create');
    if (projected !== error) throw projected;
    return { status: 'outcome_unknown', ...scope };
  }
}

export async function workflow(workflowId: string, context: PluginAccountActionContext) {
  const { workflowStatus } = await railway(context).query(
    'query($workflowId: String!) { workflowStatus(workflowId: $workflowId) { status } }', { workflowId },
  ).catch(readFailure);
  const status = isRecord(workflowStatus) ? workflowStatus.status : undefined;
  if (status !== 'Running' && status !== 'Complete' && status !== 'Error' && status !== 'NotFound') {
    throw new PluginError({ code: 'provider_response_invalid' });
  }
  return { status };
}

export async function inspect(engine: Engine, selection: ServiceSelection, context: PluginAccountActionContext) {
  const service = await railway(context).project.readServiceInstance(selection, engines[engine].template).catch(readFailure);
  if (!service) throw new PluginError({ code: 'target_mismatch' });
  return service;
}

export async function connectionReference(engine: Engine, databaseSelection: ServiceSelection, appSelection: ServiceSelection,
  context: PluginAccountActionContext) {
  if (databaseSelection.projectId !== appSelection.projectId || databaseSelection.environmentId !== appSelection.environmentId
    || databaseSelection.serviceId === appSelection.serviceId) throw new PluginError({ code: 'target_mismatch' });
  const database = await inspect(engine, databaseSelection, context);
  // The provider's reference namespace is the name of the exact service.
  if (database.name === 'shared' || /[.{}\r\n]/u.test(database.name) || database.name.trim() !== database.name) {
    throw new PluginError({ code: 'invalid_parameters' });
  }
  return { reference: '${{' + database.name + '.' + engines[engine].privateVariable + '}}' };
}

function writeRefused(error: unknown): boolean {
  return error instanceof RailwayNativeError && isMachineProvisionerCreateRefusal(error.status)
    || isPluginError(error) && (error.code === 'credential_unavailable' || error.code === 'deployment_access_denied');
}

export function removeDatabase(selection: ServiceSelection, context: PluginAccountActionContext, observeOnly: boolean) {
  const { project } = railway(context);
  return settleDeploymentTargetResourceRemovalV1({
    ...(observeOnly ? {} : { remove: async () => {
      try {
        return await project.deleteServiceInstance(selection);
      } catch (error) {
        context.signal.throwIfAborted();
        if (writeRefused(error)) return readFailure(error);
        // A lost acknowledgement can still settle from the scoped inventory.
        return false;
      }
    } }),
    observeAbsent: () => project.observeServiceAbsent(selection),
    now: Date.now,
  });
}

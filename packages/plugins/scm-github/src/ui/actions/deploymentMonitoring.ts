import { PluginError, type PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS } from '../../githubAutomationEvents.js';
import { GITHUB_DEPLOYMENT_MONITORING_OPEN_ACTION_ID, GithubDeploymentMonitoringOpenInputV1Schema } from '../../actions/deploymentMonitoring.js';
import { GITHUB_PLUGIN_ID, isGithubConnectedAccountRef, parseGithubRepositorySpecifier } from '../../observations/githubProviderContracts.js';

/** Same safe Action for Actions menus and agent intents; the host owns authoring. */
export async function openGithubDeploymentMonitoringV1(input: unknown, context: Readonly<{
  signal: AbortSignal;
  ui: Pick<PluginUiHostApi, 'openAutomationEvent'>;
}>) {
  if (context.signal.aborted) return { status: 'unavailable' as const };
  const parsed = GithubDeploymentMonitoringOpenInputV1Schema.safeParse(input);
  if (!parsed.success || (parsed.data.credentialRef !== undefined && !isGithubConnectedAccountRef(parsed.data.credentialRef))) throw new PluginError({ code: 'github_monitoring_input_invalid' });
  try { parseGithubRepositorySpecifier(parsed.data.repository); }
  catch { throw new PluginError({ code: 'github_monitoring_input_invalid' }); }
  const { repository, credentialRef, monitoringMachineId } = parsed.data;
  await context.ui.openAutomationEvent({
    eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.deploymentReview },
    ...(credentialRef ? { connectedAccount: credentialRef } : {}),
    ...(monitoringMachineId ? { monitoringMachineId } : {}),
    setupInput: { repository, ...(credentialRef ? { credentialRef } : {}),
      ...(monitoringMachineId ? { deploymentReview: { monitoringMachineId } } : {}) },
  }, { signal: context.signal });
  return { status: 'opened' as const };
}

export function activateDeploymentMonitoringClientActionsV1(api: PluginClientApi): void {
  api.actions.register(GITHUB_DEPLOYMENT_MONITORING_OPEN_ACTION_ID, openGithubDeploymentMonitoringV1);
}

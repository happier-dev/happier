import * as React from 'react';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { TELEMETRY_REGRESSION_WORKFLOW_ID_V1 } from '@happier-dev/plugins-telemetry/capture-views';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { subjectStarterEventSeed } from '@/components/workflows/triggers/subjectTriggerStarters';
import { Modal } from '@/modal';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { preparePluginWorkflowTemplateDraft } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { t } from '@/text';

/** The Telemetry plugin's regression check Workflow, named from the plugin's own ids. */
const REGRESSION_WORKFLOW = formatWorkflowDefinitionRefV1({ kind: 'plugin', contribution: {
  pluginId: parseQualifiedPluginActionId(TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1)!.pluginId,
  localId: TELEMETRY_REGRESSION_WORKFLOW_ID_V1,
} });

/**
 * An Environment's "Compare each deploy with the one before" (P7 J3): the plugin's regression Workflow as a private
 * authoring copy, its configuration carrying this Environment and its trigger this Environment's successful deploys.
 * The person authors the rest (service, measure, windows, condition, diagnosis) in the ordinary editor, whose Save and
 * native trigger owner arm it; nothing here stores a flag or writes a trigger.
 */
export function useOpenTelemetryRegressionWorkflow(
  lifetime: ServerAccountScopeLifetime,
  environment: DeploymentEnvironmentDetailV1['environment'],
) {
  const router = useRouter();
  const [opening, setOpening] = React.useState(false);
  const open = React.useCallback(async (): Promise<boolean> => {
    if (opening || !lifetime.isCurrent()) return false;
    setOpening(true);
    try {
      const { serverId } = lifetime.scope;
      const deploymentEnvironment = { serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id };
      const eventSeed = subjectStarterEventSeed('deploymentSucceeded', {
        deploymentEnvironment, controllerMachineId: environment.controllerMachineId,
      });
      const route = await preparePluginWorkflowTemplateDraft({
        accountLifetime: lifetime,
        workflow: REGRESSION_WORKFLOW,
        seed: { inputValues: { configuration: { serverId, environmentId: environment.id } }, ...(eventSeed ? { eventSeed } : {}) },
      });
      if (!route || !lifetime.isCurrent()) {
        if (lifetime.isCurrent()) Modal.alert(t('deploymentTelemetry.sheet.regressionFailed'));
        return false;
      }
      router.push(route as never);
      return true;
    } catch {
      if (lifetime.isCurrent()) Modal.alert(t('deploymentTelemetry.sheet.regressionFailed'));
      return false;
    } finally {
      setOpening(false);
    }
  }, [environment.controllerMachineId, environment.id, environment.projectSourceId, lifetime, opening, router]);
  return { opening, open };
}

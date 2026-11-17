import * as React from 'react';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { resolveDeploymentTelemetryCapabilitiesV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';
import { createDeploymentActions } from './deploymentActions';
import { showDeploymentTelemetrySheet } from './DeploymentTelemetrySheet';

/**
 * An Environment's Telemetry tab (P7 J1). Not set up, it says what telemetry is for and opens the one setup
 * sheet; set up, it names the collector and each recorded capability. Collector reads (Endpoints, Traces,
 * Logs, Queries, LLM calls, Metrics) and their freshness come from the telemetry plugin's status owner.
 */
export function DeploymentTelemetryPanel(
  props: Readonly<{
    detail: DeploymentEnvironmentDetailV1;
    lifetime: ServerAccountScopeLifetime | null;
    environmentName: string;
    /** Re-read the Environment after a save, so the next save carries its new revision. */
    onChanged: () => void;
  }>,
) {
  const { detail, lifetime } = props;
  const environment = detail.environment;
  const collectorId = environment.telemetryMachineId ?? null;
  const collector = useServerScopedMachineLabel(
    lifetime?.scope.serverId ?? null,
    collectorId,
  );
  // The Action answers redeploy_required: the saved choice is a fact until the next deploy applies it.
  const [savedThisVisit, setSavedThisVisit] = React.useState(false);
  const canManage = environment.capabilities.manageBindings;
  const open = React.useCallback(() => {
    if (!lifetime) return;
    showDeploymentTelemetrySheet({
      detail,
      lifetime,
      environmentName: props.environmentName,
      setTelemetry: input => createDeploymentActions(lifetime, environment.projectSourceId).setTelemetry(environment, input),
      onSaved: () => {
        setSavedThisVisit(true);
        props.onChanged();
      },
    });
  }, [detail, environment, lifetime, props.environmentName, props.onChanged]);
  if (!collectorId) {
    return (
      <EmptyState
        testID="project-deployments.telemetry.off"
        layout="page"
        scene="nothingListening"
        title={t('deploymentTelemetry.empty.title', {
          name: props.environmentName,
        })}
        subtitle={t('deploymentTelemetry.empty.body')}
        {...(canManage && lifetime
          ? {
              primaryAction: {
                label: t('deploymentTelemetry.empty.action'),
                onPress: open,
                testID: 'project-deployments.telemetry.setup',
              },
            }
          : {
              actionUnavailableReason: t('deploymentTelemetry.sheet.noAccess'),
            })}
      />
    );
  }
  const capabilities = resolveDeploymentTelemetryCapabilitiesV1(
    detail.content.telemetry,
  );
  const word = (on: boolean) =>
    on ? t('deploymentTelemetry.state.on') : t('deploymentTelemetry.state.off');
  const machine = collector ?? t('projects.deployments.aMachine');
  return (
    <ItemGroup
      testID="project-deployments.telemetry.recording"
      title={t('deploymentTelemetry.recording.title')}
      description={
        savedThisVisit
          ? `${t('deploymentTelemetry.recording.keptOn', { machine })} ${t('deploymentTelemetry.recording.nextDeploy')}`
          : t('deploymentTelemetry.recording.keptOn', { machine })
      }
      action={
        canManage && lifetime ? (
          <SectionActionButton testID="project-deployments.telemetry.change" title={t('common.change')} onPress={open} />
        ) : undefined
      }
    >
      <Item
        title={t('deploymentTelemetry.sheet.requests')}
        subtitle={t('deploymentTelemetry.sheet.requestsDescription')}
        detail={word(true)}
        showChevron={false}
      />
      <Item
        title={t('deploymentTelemetry.sheet.exceptions')}
        subtitle={t('deploymentTelemetry.sheet.exceptionsDescription')}
        detail={word(capabilities.exceptions)}
        showChevron={false}
      />
      <Item
        title={t('deploymentTelemetry.sheet.llm')}
        subtitle={t('deploymentTelemetry.sheet.llmDescription')}
        detail={word(capabilities.appLlmCost)}
        showChevron={false}
      />
      <Item
        title={t('deploymentTelemetry.sheet.metrics')}
        subtitle={t('deploymentTelemetry.sheet.metricsDescription')}
        detail={word(capabilities.metrics)}
        showChevron={false}
      />
    </ItemGroup>
  );
}

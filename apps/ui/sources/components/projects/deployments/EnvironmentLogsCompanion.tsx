import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';

import { DetailCompanionPane } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { MachineServiceLogs } from '@/components/machines/services/MachineServiceLogs';
import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { SegmentedTabBar, SegmentedValueSelect } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { DeploymentStepLogs } from './DeploymentStepLogs';
import { useDeploymentReceipt } from './useDeploymentReads';
import type { DeploymentReadLogs } from './useDeploymentStepLog';

type EnvironmentLogsView = 'build' | 'runtime';

/**
 * The Logs companion (P11): beside the Environment on desktop, pushed on a phone, through the host companion pane.
 * Build shows the latest deploy receipt's own step logs (the receipt's viewer); Runtime shows the chosen service's
 * native log through the Machine service log viewer. Nothing reads until it is open.
 */
export function EnvironmentLogsCompanion(
  props: Readonly<{
    open: boolean;
    onClose: () => void;
    services: readonly Readonly<{ name: string }>[];
    service: string | null;
    serverId: string;
    environmentId: string;
    machineId: string | null;
    machineName: string;
    machineNames: Readonly<Record<string, string>>;
    controller: DeploymentReadControllerV1;
    deploymentId: string | null;
    demand: DeploymentReadDemandV1;
    readLogs: DeploymentReadLogs | null;
  }>,
) {
  const runtimeAvailable = props.machineId !== null && props.services.length > 0;
  const [view, setView] = React.useState<EnvironmentLogsView>(runtimeAvailable ? 'runtime' : 'build');
  const [chosen, setChosen] = React.useState<string | null>(null);
  // A row's Logs names its service; until the person picks another, the companion follows that row.
  React.useEffect(() => { setChosen(null); if (props.service !== null && runtimeAvailable) setView('runtime'); },
    [props.service, runtimeAvailable]);
  const serviceName = chosen ?? props.service ?? props.services[0]?.name ?? null;
  const shown = runtimeAvailable ? view : 'build';
  const receipt = useDeploymentReceipt(props.open && shown === 'build' ? props.controller : null,
    props.environmentId, props.deploymentId, props.demand);
  const value = receipt.snapshot.value;
  const tabs = React.useMemo(() => [
    { id: 'build' as const, label: t('projects.deployments.overviewStatus.logsBuild') },
    { id: 'runtime' as const, label: t('projects.deployments.overviewStatus.logsRuntime'), disabled: !runtimeAvailable },
  ], [runtimeAvailable]);
  const serviceTabs = React.useMemo(() => props.services.map((service) => ({ id: service.name, label: service.name })),
    [props.services]);
  const actions = (
    <View style={styles.logsActions}>
      {shown === 'runtime' && serviceName && serviceTabs.length > 1 ? (
        <SegmentedValueSelect
          tabs={serviceTabs}
          activeTabId={serviceName}
          onSelectTab={setChosen}
          disabled={false}
          accessibilityLabel={t('projects.deployments.overviewStatus.logsService')}
          testID="environment-logs.service"
        />
      ) : null}
      <SegmentedTabBar<EnvironmentLogsView>
        role="radiogroup"
        segmentSizing="content"
        compact
        accessibilityLabel={t('projects.deployments.overviewStatus.logsTitle')}
        testIDPrefix="environment-logs.view"
        activeTabId={shown}
        tabs={tabs}
        onSelectTab={setView}
      />
    </View>
  );
  return (
    <DetailCompanionPane
      open={props.open}
      title={t('projects.deployments.overviewStatus.logsTitle')}
      {...(shown === 'runtime' && serviceName ? { subtitle: serviceName } : {})}
      actions={actions}
      onClose={props.onClose}
      testID="environment-logs"
    >
      {!props.open ? null : shown === 'runtime' && props.machineId && serviceName ? (
        <EnvironmentRuntimeLogs
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={props.machineName}
          environmentId={props.environmentId}
          service={serviceName}
        />
      ) : value ? (
        <ItemList testID="environment-logs.build">
          <DeploymentStepLogs
            testID="environment-logs.build.steps"
            title={t('projects.deployments.steps')}
            machineName={value.content.machineResults[0]
              ? props.machineNames[value.content.machineResults[0].machineId] ?? props.machineName : props.machineName}
            machineNames={props.machineNames}
            machineId={value.content.steps.length > 0 ? undefined : value.content.machineResults[0]?.machineId}
            steps={value.content.steps.length > 0 ? value.content.steps : (value.content.machineResults[0]?.steps ?? [])}
            facts={value.facts}
            running={value.deployment.state === 'running' || value.deployment.state === 'queued'}
            serverId={props.serverId}
            readLogs={props.readLogs}
            fileStem={`deploy-${value.deployment.id}`}
          />
        </ItemList>
      ) : props.deploymentId ? (
        receipt.snapshot.status === 'unavailable' ? (
          <SurfaceStateCard
            testID="environment-logs.error"
            kind="error"
            title={t('projects.deployments.environmentErrorTitle')}
            diagnosticCode={receipt.snapshot.failure?.code ?? null}
            action={{ label: t('common.retry'), onPress: () => { void receipt.refresh(); } }}
          />
        ) : <PageLoadingRows testID="environment-logs.loading" />
      ) : (
        <SurfaceStateCard
          testID="environment-logs.empty"
          kind="empty"
          title={t('projects.deployments.overviewStatus.logsEmpty')}
          reason={t('projects.deployments.overviewStatus.logsNoBuild')}
        />
      )}
    </DetailCompanionPane>
  );
}

/** One service's runtime log from the Machine's admitted services list; read only while shown. */
function EnvironmentRuntimeLogs(
  props: Readonly<{ serverId: string; machineId: string; machineName: string; environmentId: string; service: string }>,
) {
  const list = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId, active: true });
  const row = list.rows?.find((candidate) => candidate.environmentId === props.environmentId
    && candidate.deployment?.service.composeService === props.service) ?? null;
  if (!row) {
    return list.pending ? <PageLoadingRows testID="environment-logs.loading" /> : (
      <SurfaceStateCard
        testID="environment-logs.empty"
        kind="empty"
        title={t('projects.deployments.overviewStatus.logsEmpty')}
      />
    );
  }
  return (
    <ItemList testID="environment-logs.runtime">
      <MachineServiceLogs serverId={props.serverId} machineId={props.machineId} machineName={props.machineName}
        service={row} active />
    </ItemList>
  );
}

const styles = StyleSheet.create((theme) => ({
  logsActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));

import * as React from 'react';
import type { DeploymentActivityItemV1 } from '@happier-dev/deployments';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  describeActionOperationStatusLabel,
  resolveActionOperationStatus,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { deploymentEnvironmentRoute } from '@/components/projects/deployments/deploymentNavigation';
import {
  deploymentOperationLabel,
  deploymentReceiptTitle,
  deploymentRevisionLabel,
  deploymentWorkStatus,
} from '@/components/projects/deployments/deploymentPresentation';
import { useDeploymentInventory } from '@/components/projects/deployments/useDeploymentProject';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import {
  buildSessionListDateGroups,
  formatDayGroupedAgeShort,
} from '@/sync/domains/session/listing/sessionListDateGroups';
import {
  useActiveServerAccountScopeLifetime,
  useMachineListForServerSelection,
} from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

import { useFleetActivityPage } from './useFleetActivityPage';

const s = 'machineFleetActivity' as const;
const NO_TITLES: ReadonlyMap<string, string> = new Map();

const selectMachineIds = (() => {
  let previous: readonly string[] = [];
  return (machines: readonly Machine[]): readonly string[] => {
    const next = machines.map((machine) => machine.id);
    if (
      next.length === previous.length &&
      next.every((id, index) => id === previous[index])
    )
      return previous;
    previous = next;
    return next;
  };
})();

/**
 * Machines → Activity (pfc-redesign fAct): what happened on this Home's Machines and services, newest first by day:
 * deploy receipts and Machine Action operations from the one activity read. History only; what needs you stays in
 * Inbox. A row opens its receipt or its operation.
 */
export function MachineFleetActivityView() {
  const router = useRouter();
  const lifetime = useActiveServerAccountScopeLifetime();
  const serverId = lifetime?.scope.serverId ?? '';
  const layoutPresented = useLayoutPresentationActive();
  const focused = useOptionalScreenIsFocused() !== false;
  const presented = layoutPresented && focused;
  const machineIds = useMachineListForServerSelection(
    serverId,
    selectMachineIds,
  );
  const { state, loadMore, retry } = useFleetActivityPage(
    lifetime,
    machineIds,
    presented,
  );
  const demand = React.useMemo(
    () => ({ mounted: true, visible: presented, focused: presented }),
    [presented],
  );
  const inventory = useDeploymentInventory(lifetime, demand);
  const inventoryItems = inventory.snapshot.value?.items;
  const titles = React.useMemo(
    () =>
      inventoryItems
        ? new Map(
            inventoryItems.map((item) => [item.environment.id, item.title]),
          )
        : NO_TITLES,
    [inventoryItems],
  );
  const days = React.useMemo(
    () =>
      buildSessionListDateGroups({
        items: state.items,
        readMeaningfulActivityAt: (item) => item.requestedAtMs,
      }),
    [state.items],
  );

  return (
    <ItemList>
      <SettingsPageHeader
        testID="machines.activity.header"
        alwaysShowTitle
        description={t(`${s}.description`)}
      />
      {state.coverage === 'partial' && state.status === 'ready' ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machines.activity.partial"
            kind="warning"
            size="line"
            title={t(`${s}.partial`)}
            action={{ label: t('common.retry'), onPress: retry }}
          />
        </ItemGroup>
      ) : null}
      {state.status === 'loading' ? (
        <ItemGroup surface="none" testID="machines.activity.loading">
          <SkeletonRows rows={5} />
        </ItemGroup>
      ) : state.status === 'failed' ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machines.activity.error"
            kind="error"
            size="line"
            title={t('projects.deployments.unavailableTitle')}
            diagnosticCode={state.failureCode}
            action={{ label: t('common.retry'), onPress: retry }}
          />
        </ItemGroup>
      ) : state.items.length === 0 ? (
        // An incomplete read never claims nothing happened: the partial line above already says what is missing.
        state.coverage === 'partial' ? null : <EmptyState
          testID="machines.activity.empty"
          layout="page"
          scene="shipped"
          title={t(`${s}.emptyTitle`)}
          subtitle={t(`${s}.emptyBody`)}
        />
      ) : (
        <>
          {days.map((day) => (
            <ItemGroup
              key={day.dateKey}
              testID={`machines.activity.day.${day.dateKey}`}
              title={day.title}
            >
              {day.items.map((item) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  serverId={serverId}
                  accountId={lifetime?.scope.accountId ?? ''}
                  environmentTitle={
                    item.kind === 'receipt'
                      ? (titles.get(item.environment.id) ?? null)
                      : null
                  }
                  onOpenReceipt={(
                    environmentId,
                    projectSourceId,
                    deploymentId,
                  ) =>
                    router.push(
                      deploymentEnvironmentRoute({
                        serverId,
                        projectSourceId,
                        environmentId,
                        deploymentId,
                      }) as never,
                    )
                  }
                />
              ))}
            </ItemGroup>
          ))}
          {state.nextCursor ? (
            <ItemGroup surface="none" header="none">
              <SectionActionButton
                testID="machines.activity.older"
                title={t('projects.deployments.pageOlder')}
                icon="caret-right"
                loading={state.loadingMore}
                onPress={loadMore}
              />
            </ItemGroup>
          ) : null}
        </>
      )}
    </ItemList>
  );
}

const ActivityRow = React.memo(function ActivityRow(
  props: Readonly<{
    item: DeploymentActivityItemV1;
    serverId: string;
    accountId: string;
    environmentTitle: string | null;
    onOpenReceipt: (
      environmentId: string,
      projectSourceId: string,
      deploymentId: string,
    ) => void;
  }>,
) {
  const { item } = props;
  const machineId =
    item.kind === 'operation'
      ? item.operation.scope.machineId
      : (item.receipt.machineIds?.[0] ?? null);
  const machine = useServerScopedMachineLabel(props.serverId, machineId);
  const age = formatDayGroupedAgeShort(item.requestedAtMs, Date.now());
  if (item.kind === 'receipt') {
    const { receipt, environment } = item;
    return (
      <Item
        testID={`machines.activity.receipt.${receipt.id}`}
        leftElement={
          <WorkStatusGlyph
            status={deploymentWorkStatus(receipt.state)}
            testIDSuffix={`activity-${receipt.id}`}
          />
        }
        title={
          receipt.source
            ? deploymentReceiptTitle(
                receipt,
                deploymentRevisionLabel(receipt.source),
              )
            : (receipt.title ?? deploymentOperationLabel(receipt.operation))
        }
        subtitle={
          [
            props.environmentTitle,
            receipt.requestedByAccountId === props.accountId
              ? t('projects.deployments.byYou')
              : null,
            machine ? t(`${s}.onMachine`, { machine }) : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        detail={age}
        onPress={() =>
          props.onOpenReceipt(
            environment.id,
            environment.projectSourceId,
            receipt.id,
          )
        }
      />
    );
  }
  const { operation } = item;
  const status = resolveActionOperationStatus(operation, 'available');
  const word = describeActionOperationStatusLabel(status.label);
  return (
    <Item
      testID={`machines.activity.operation.${operation.operationId}`}
      leftElement={
        <WorkStatusGlyph
          status={resolveWorkStatusTone({
            kind: 'action_operation',
            facts: {
              state: operation.state,
              observation: 'available',
              setupReview: operation.setupReview,
              word,
            },
          })}
          testIDSuffix={`activity-${operation.operationId}`}
        />
      }
      title={operation.title}
      subtitle={[word, machine ? t(`${s}.onMachine`, { machine }) : null]
        .filter(Boolean)
        .join(' · ')}
      detail={age}
      onPress={() =>
        openActionOperationDetail({
          serverId: props.serverId,
          operationId: operation.operationId,
        })
      }
    />
  );
});

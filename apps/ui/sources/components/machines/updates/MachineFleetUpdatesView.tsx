import * as React from 'react';
import type { WorkflowFailurePolicy } from '@happier-dev/protocol/workflows/workflowV1';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { ActionConfirmationReviewFacts } from '@/components/approvals/ActionConfirmationReview';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveTriggerEditorHref } from '@/components/workflows/triggers/triggerEditorDestination';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { isMachineOnline } from '@/sync/domains/machines/reachability/machinePresence';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachineListForServerSelection } from '@/sync/store/hooks';
import { t } from '@/text';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import type { MachineUpdatesScope } from '../security/machineUpdatesActions';
import { useMachineUpdatesPage } from '../security/useMachineUpdatesPage';
import {
  fleetRolloutCandidates,
  orderFleetUpdatesRows,
  readFleetUpdatesRow,
  summarizeFleetUpdates,
  type FleetMachine,
  type FleetUpdatesRow,
} from './machineFleetUpdates';
import { useMachineFleetRollout } from './useMachineFleetRollout';

const s = 'machineFleetUpdates' as const;

/** One Home's Machines as the facts this page shows; the same array while none of them changed. */
function useFleetMachines(serverId: string): readonly FleetMachine[] {
  const select = React.useMemo(() => {
    let previous: readonly FleetMachine[] | null = null;
    return (machines: readonly Machine[]) => {
      previous = retainKeyedRows(
        previous,
        machines.map((machine) => ({
          machineId: machine.id,
          name: getSettledMachineDisplayName(machine) ?? machine.id,
          online: isMachineOnline(machine),
          installationId: machine.installationId ?? null,
        })),
        (row) => row.machineId,
      );
      return previous;
    };
  }, []);
  return useMachineListForServerSelection(serverId, select);
}

function listNames(names: readonly string[]): string {
  return names.join(', ');
}

function describeRow(
  row: FleetUpdatesRow,
): Readonly<{ subtitle: string; detail: string; attention: boolean }> {
  if (row.online === false)
    return { subtitle: t(`${s}.offline`), detail: '—', attention: false };
  if (row.security === null && row.all === null)
    return { subtitle: t(`${s}.notChecked`), detail: '—', attention: false };
  const parts = [
    row.security === null ? null : t(`${s}.security`, { count: row.security }),
    row.all === null ? null : t(`${s}.all`, { count: row.all }),
    row.restartNeeded ? t(`${s}.restartNeeded`) : null,
  ].filter((part): part is string => part !== null);
  const waiting = (row.security ?? 0) > 0 || (row.all ?? 0) > 0;
  return {
    subtitle: parts.join(' · '),
    detail: waiting
      ? t(`${s}.waiting`)
      : row.restartNeeded
        ? t(`${s}.restartNeeded`)
        : t(`${s}.upToDate`),
    attention: (row.security ?? 0) > 0 || row.restartNeeded,
  };
}

/**
 * Machines → Updates (pfc-redesign fUpd, flow 10): operating-system packages waiting on each Machine of this Home,
 * from the facts each Machine pushes, and one reviewed rollout to the ones that have them, now or as a Workflow later.
 */
export function MachineFleetUpdatesView() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { serverId } = useActiveServerSnapshot();
  const machines = useFleetMachines(serverId);
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.machineId),
    [machines],
  );
  const entries = useMachineUpdatesPage({
    serverId,
    machineIds,
    enabled: machines.length > 0,
  });
  const rows = React.useMemo(
    () =>
      orderFleetUpdatesRows(machines.map((machine, index) =>
        readFleetUpdatesRow(machine, entries[index]),
      )),
    [entries, machines],
  );
  const summary = summarizeFleetUpdates(rows);

  const [reviewing, setReviewing] = React.useState(false);
  const [scope, setScope] = React.useState<MachineUpdatesScope>('security');
  const [failurePolicy, setFailurePolicy] =
    React.useState<WorkflowFailurePolicy>('fail_stop');
  const [restartIfNeeded, setRestartIfNeeded] = React.useState(true);
  const [when, setWhen] = React.useState<'now' | 'later'>('now');
  const onSettled = React.useCallback(() => {}, []);
  const { rollout, confirmation, prepare, start, cancel } =
    useMachineFleetRollout({ serverId, onSettled });
  const candidates = fleetRolloutCandidates(rows, scope);

  const close = React.useCallback(() => {
    cancel();
    setReviewing(false);
  }, [cancel]);
  const openApproval = (artifactId: string) =>
    router.push(buildApprovalHref(artifactId, serverId) as never);
  const openMachine = (machineId: string) =>
    router.push(
      machinePageHref({
        door: 'rail',
        target: { serverId, machineId },
        tab: { id: 'security' },
      }) as never,
    );

  const onStart = async () => {
    const targetIds = new Set(
      rollout.kind === 'review'
        ? rollout.targets.map((target) => target.machine.machineId)
        : [],
    );
    const definitionId = await start({
      others: machines.filter((machine) => !targetIds.has(machine.machineId)),
      failurePolicy,
      restartIfNeeded,
      later: when === 'later',
      title: t(
        scope === 'security'
          ? `${s}.workflowTitleSecurity`
          : `${s}.workflowTitleAll`,
      ),
    });
    if (definitionId) {
      setReviewing(false);
      router.push(
        resolveTriggerEditorHref({
          serverId,
          workflowDefinitionId: definitionId,
        }) as never,
      );
    }
  };

  const status =
    summary.machines === 0
      ? null
      : [
          t(`${s}.statusWith`, {
            count: summary.withUpdates,
            total: summary.machines,
          }),
          summary.security > 0
            ? t(`${s}.security`, { count: summary.security })
            : null,
          summary.restarts > 0
            ? t(`${s}.restarts`, { count: summary.restarts })
            : null,
          // A few offline machines are named; a fleet's many sleeping ones are counted (their rows say so).
          summary.offline.length > 2
            ? t(`${s}.offlineCount`, { count: summary.offline.length })
            : summary.offline.length > 0
              ? t(`${s}.offlineNamed`, { names: listNames(summary.offline) })
              : null,
        ]
          .filter(Boolean)
          .join(' · ');

  const showReview = reviewing || rollout.kind !== 'idle';
  return (
    <ItemList>
      <SettingsPageHeader
        testID="machines.updates.header"
        alwaysShowTitle
        description={t(`${s}.description`)}
        primaryAction={
          showReview
            ? undefined
            : {
                testID: 'machines.updates.review',
                title: t(`${s}.reviewRollout`),
                onPress: () => setReviewing(true),
              }
        }
      />
      {showReview ? (
        <FleetRolloutReview
          rollout={rollout}
          scope={scope}
          onScope={setScope}
          candidates={candidates}
          offline={summary.offline}
          failurePolicy={failurePolicy}
          onFailurePolicy={setFailurePolicy}
          restartIfNeeded={restartIfNeeded}
          onRestartIfNeeded={setRestartIfNeeded}
          when={when}
          onWhen={setWhen}
          confirmation={confirmation}
          serverId={serverId}
          onPrepare={() => {
            void prepare(scope, candidates);
          }}
          onStart={() => {
            void onStart();
          }}
          onClose={close}
          onOpenApproval={openApproval}
          onOpenOperation={(operationId) =>
            openActionOperationDetail({ serverId, operationId })
          }
        />
      ) : null}
      {machines.length === 0 ? (
        <EmptyState
          testID="machines.updates.empty"
          layout="page"
          scene="shipped"
          title={t(`${s}.emptyTitle`)}
          subtitle={t(`${s}.emptyBody`)}
        />
      ) : (
        <ItemGroup
          testID="machines.updates.list"
          title={t('settings.machines')}
          description={status ?? undefined}
        >
          {rows.map((row) => {
            const shown = describeRow(row);
            return (
              <Item
                key={row.machineId}
                testID={`machines.updates.row.${row.machineId}`}
                title={row.name}
                subtitle={shown.subtitle}
                detail={shown.detail}
                detailStyle={
                  shown.attention
                    ? { color: theme.colors.state.warning }
                    : undefined
                }
                onPress={() => openMachine(row.machineId)}
              />
            );
          })}
        </ItemGroup>
      )}
    </ItemList>
  );
}

function FleetRolloutReview(
  props: Readonly<{
    rollout: ReturnType<typeof useMachineFleetRollout>['rollout'];
    scope: MachineUpdatesScope;
    onScope: (scope: MachineUpdatesScope) => void;
    candidates: readonly FleetUpdatesRow[];
    offline: readonly string[];
    failurePolicy: WorkflowFailurePolicy;
    onFailurePolicy: (policy: WorkflowFailurePolicy) => void;
    restartIfNeeded: boolean;
    onRestartIfNeeded: (value: boolean) => void;
    when: 'now' | 'later';
    onWhen: (when: 'now' | 'later') => void;
    confirmation: ReturnType<typeof useMachineFleetRollout>['confirmation'];
    serverId: string;
    onPrepare: () => void;
    onStart: () => void;
    onClose: () => void;
    onOpenApproval: (artifactId: string) => void;
    onOpenOperation: (operationId: string) => void;
  }>,
) {
  const { rollout } = props;
  if (rollout.kind === 'rolling' || rollout.kind === 'settled') {
    const settled = rollout.kind === 'settled' ? rollout.state : null;
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machines.updates.progress"
          kind={
            settled === null
              ? 'loading'
              : settled === 'succeeded'
                ? 'success'
                : 'error'
          }
          layout="inline"
          size="line"
          title={
            settled === null
              ? t(`${s}.rollingOut`, { count: rollout.count })
              : settled === 'succeeded'
                ? t(`${s}.rolledOut`, { count: rollout.count })
                : t(`${s}.rolloutFailed`)
          }
          action={{
            label: t(`${s}.showDetails`),
            onPress: () => props.onOpenOperation(rollout.operationId),
          }}
          secondaryAction={
            settled === null
              ? undefined
              : { label: t('common.close'), onPress: props.onClose }
          }
        />
      </ItemGroup>
    );
  }
  if (rollout.kind === 'failed') {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machines.updates.failed"
          kind="error"
          layout="inline"
          size="line"
          title={
            rollout.machine
              ? t(`${s}.prepareFailed`, { machine: rollout.machine })
              : t(`${s}.rolloutFailed`)
          }
          diagnosticCode={rollout.failure.errorCode}
          action={{ label: t('common.close'), onPress: props.onClose }}
        />
      </ItemGroup>
    );
  }
  const reviewed =
    rollout.kind === 'review' || rollout.kind === 'starting'
      ? rollout.targets
      : null;
  const approval =
    rollout.kind === 'preparing' || rollout.kind === 'starting'
      ? rollout.approval
      : null;
  const busy = rollout.kind === 'preparing' || rollout.kind === 'starting';
  const reach =
    props.candidates.length === 0
      ? t(`${s}.noneToRollOut`)
      : [
          listNames(props.candidates.map((row) => row.name)),
          props.offline.length > 0
            ? t(`${s}.skippedOffline`, { names: listNames(props.offline) })
            : null,
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <>
      <ItemGroup
        testID="machines.updates.rollout"
        title={t(`${s}.rolloutTitle`)}
        description={t(`${s}.rolloutDescription`)}
      >
        <SegmentedChoiceItem
          testID="machines.updates.scope"
          testIDPrefix="machines.updates.scope"
          title={t(`${s}.whichUpdates`)}
          subtitle={reviewed ? undefined : reach}
          disabled={reviewed !== null || busy}
          value={props.scope}
          onChange={props.onScope}
          options={[
            { id: 'security', label: t(`${s}.securityOnly`) },
            { id: 'all', label: t(`${s}.allUpdates`) },
          ]}
        />
        {rollout.kind === 'preparing' ? (
          <Item
            testID="machines.updates.preparing"
            title={t(`${s}.preparing`, { machine: rollout.machine })}
            loading
            showChevron={false}
          />
        ) : null}
        {reviewed?.map((target) => (
          <Item
            key={target.machine.machineId}
            testID={`machines.updates.planned.${target.machine.machineId}`}
            title={target.machine.name}
            subtitle={listNames(target.packages.map((item) => item.name))}
            detail={t(`${s}.packages`, { count: target.packages.length })}
            showChevron={false}
          />
        ))}
        {rollout.kind === 'review' && rollout.nothing.length > 0 ? (
          <Item
            testID="machines.updates.nothing"
            title={t(`${s}.nothingOn`, { names: listNames(rollout.nothing) })}
            showChevron={false}
            mode="info"
          />
        ) : null}
        {approval ? (
          <ActionApprovalPendingNotice
            testID="machines.updates.approval"
            message={t(`${s}.approvalWaiting`)}
            onOpenApproval={() => props.onOpenApproval(approval.artifactId)}
          />
        ) : null}
      </ItemGroup>
      {reviewed ? (
        <ItemGroup testID="machines.updates.order" title={t(`${s}.orderTitle`)}>
          <SegmentedChoiceItem
            testID="machines.updates.how"
            testIDPrefix="machines.updates.how"
            title={t(`${s}.how`)}
            subtitle={t(`${s}.oneAtATime`)}
            disabled={busy}
            value={props.failurePolicy}
            onChange={props.onFailurePolicy}
            options={[
              { id: 'fail_stop', label: t(`${s}.stopOnFailure`) },
              { id: 'collect_outcomes', label: t(`${s}.keepGoing`) },
            ]}
          />
          <Item
            testID="machines.updates.restart"
            title={t(`${s}.restartsTitle`)}
            subtitle={t(`${s}.restartIfNeeded`)}
            showChevron={false}
            rightElement={
              <Switch
                value={props.restartIfNeeded}
                disabled={busy}
                onValueChange={props.onRestartIfNeeded}
              />
            }
          />
          <SegmentedChoiceItem
            testID="machines.updates.when"
            testIDPrefix="machines.updates.when"
            title={t(`${s}.when`)}
            subtitle={props.when === 'later' ? t(`${s}.laterNote`) : undefined}
            disabled={busy}
            value={props.when}
            onChange={props.onWhen}
            options={[
              { id: 'now', label: t(`${s}.now`) },
              { id: 'later', label: t(`${s}.later`) },
            ]}
          />
        </ItemGroup>
      ) : null}
      {props.confirmation ? (
        <ActionConfirmationReviewFacts
          actionId={props.confirmation.actionId}
          actionArgs={props.confirmation.actionArgs}
          summaryPlacement="host"
          preview={props.confirmation.preview}
          serverId={props.serverId}
          testID="machines.updates.confirmation"
        />
      ) : null}
      <ItemGroup surface="none">
        <SectionButtonRow>
          {reviewed ? (
            <RoundButton
              testID="machines.updates.start"
              size="small"
              title={
                props.when === 'later'
                  ? t(`${s}.saveForLater`)
                  : t(`${s}.rollOutTo`, { count: reviewed.length })
              }
              disabled={
                reviewed.length === 0 ||
                (rollout.kind === 'starting' && !props.confirmation)
              }
              loading={
                rollout.kind === 'starting' &&
                approval === null &&
                !props.confirmation
              }
              onPress={props.onStart}
            />
          ) : (
            <RoundButton
              testID="machines.updates.prepare"
              size="small"
              title={t(`${s}.prepare`, { count: props.candidates.length })}
              disabled={props.candidates.length === 0 || busy}
              loading={busy && approval === null}
              onPress={props.onPrepare}
            />
          )}
          <RoundButton
            testID="machines.updates.cancel"
            size="small"
            display="secondary"
            title={t('common.cancel')}
            onPress={props.onClose}
          />
        </SectionButtonRow>
      </ItemGroup>
    </>
  );
}

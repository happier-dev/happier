import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { MachineSetupPackageHoldV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSecurityInspectResultV1 } from '@happier-dev/protocol/machines/security/machineSecurityInspectV1';
import { MACHINE_SETUP_PLAN_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { describeMachineSetupReason } from '@/components/machines/setup/machineSetupReasonText';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { ActionConfirmationReviewFacts } from '@/components/approvals/ActionConfirmationReview';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { resolveMachineAvailabilityReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import {
  describeActionExecutionPrerequisite,
  resolveActionExecutionErrorMessage,
} from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { UpdateRow } from '@/components/updates/UpdateRow';
import type { UpdateItem } from '@/updates/items/updateItem';
import { useUpdatesContentModel } from '@/updates/useUpdatesContentModel';
import { StoreUpdateRow, useStoreUpdateRowHost, type StoreUpdateRowHost } from '@/components/store/updates/StoreUpdateRow';
import type { StoreUpdateEntry } from '@/components/store/updates/storeUpdatesModel';
import { joinList } from '@/utils/text/joinList';

import { MachineAdminPowerSection } from './MachineAdminPowerSection';
import type { MachineUpdatesScope } from './machineUpdatesActions';
import {
  useMachineSecurityReboot,
  type MachineSecurityReboot,
} from './useMachineSecurityReboot';
import type { useMachineUpdates } from './useMachineUpdates';
import {
  useMachineUpdatesReview,
  type MachineUpdatesReview,
} from './useMachineUpdatesReview';

export type MachineUpdatesModel = Omit<ReturnType<typeof useMachineUpdates>, 'projection'>;

export type MachineSecurityRepairControls = Readonly<{
  onFix: (repair: NonNullable<MachineSecurityInspectResultV1['rows'][number]['repair']>) => void;
  busy: boolean;
  canFix: boolean;
}>;

export type MachineSecurityControls = Readonly<{
  review: MachineUpdatesReview;
  onPrepare: (scope: MachineUpdatesScope, hold?: MachineSetupPackageHoldV1) => void;
  onApply: () => void;
  onCancel: () => void;
  reboot: MachineSecurityReboot;
  /** False while the Machine's exact installation is not known: a restart can't name what it restarts. */
  canReboot: boolean;
  onReboot: () => void;
  onDismissReboot: () => void;
  onOpenApproval: (artifactId: string) => void;
  onOpenOperation: (operationId: string) => void;
}>;

/**
 * Machine → Security (Plan 20 updates, Plan 30 restart): what the Machine's package manager has waiting and whether
 * it needs a restart. Facts come from the pushed setup observation (`useMachineUpdates`), read again on open,
 * on pull to refresh and after an install or restart settles; never on a timer.
 */
export function MachineSecuritySection(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    installationId: string | null;
    online: boolean | null;
    refreshKey: number;
    metadataVersion: number;
    metadataReadable: boolean;
    /** Elevation needs Manage (10-31); a Use grantee reads the facts only. */
    canManage: boolean;
    shared: boolean;
    updates: MachineUpdatesModel;
    renderGrade?: (fix: MachineSecurityRepairControls) => React.ReactNode;
    /** How the Machine is reached and who shares it, placed after administrator power (P-M2 order). */
    reach?: React.ReactNode;
  }>,
) {
  const router = useRouter();
  const { updates } = props;
  const { refresh } = updates;
  const { happier, store } = useMachineUpdateRows(props.machineId);
  const onSettled = React.useCallback(() => {
    void refresh();
  }, [refresh]);
  const onUpdatesSettled = React.useCallback(() => {
    void refresh('settled');
  }, [refresh]);
  const updatesReview = useMachineUpdatesReview({
    serverId: props.serverId,
    machineId: props.machineId,
    onSettled: onUpdatesSettled,
  });
  const reboot = useMachineSecurityReboot({
    serverId: props.serverId,
    machineId: props.machineId,
    installationId: props.installationId,
    onSettled,
  });

  // The page's pull to refresh asks the Machine again; the first render's read is the hook's own.
  const firstRefreshKey = React.useRef(props.refreshKey);
  React.useEffect(() => {
    if (props.refreshKey !== firstRefreshKey.current) void refresh();
  }, [props.refreshKey, refresh]);

  const { prepare, apply, cancel } = updatesReview;
  const controls: MachineSecurityControls = {
    review: updatesReview.review,
    onPrepare: (scope, hold) => {
      void prepare(scope, hold);
    },
    onApply: () => {
      void apply();
    },
    onCancel: cancel,
    reboot: reboot.reboot,
    canReboot: props.installationId !== null,
    onReboot: () => {
      void reboot.start();
    },
    onDismissReboot: reboot.dismiss,
    onOpenApproval: (artifactId) =>
      router.push(buildApprovalHref(artifactId, props.serverId) as never),
    onOpenOperation: (operationId) =>
      openActionOperationDetail({ serverId: props.serverId, operationId }),
  };
  const fix: MachineSecurityRepairControls = {
    canFix: props.canManage && props.online === true,
    busy: isMachineUpdateReviewBusy(controls.review)
      || controls.reboot.kind === 'starting' || controls.reboot.kind === 'restarting',
    onFix: (repair) => {
      if (repair.actionId === MACHINE_SETUP_PLAN_ACTION_ID_V1) {
        controls.onPrepare(repair.inputHints.scope);
      } else if (controls.canReboot) {
        controls.onReboot();
      }
    },
  };
  return (
    <>
      {props.renderGrade?.(fix)}
      <MachineAdminPowerSection
        serverId={props.serverId}
        machineId={props.machineId}
        machineName={props.machineName}
        online={props.online}
        metadataVersion={props.metadataVersion}
        metadataReadable={props.metadataReadable}
        canManage={props.canManage}
        shared={props.shared}
        onOpenApproval={controls.onOpenApproval}
      />
      {props.reach}
      <MachineSecurityView
        updates={updates}
        machineName={props.machineName}
        online={props.online}
        controls={controls}
        canManage={props.canManage}
        happier={happier}
        store={store}
        serverId={props.serverId}
      />
    </>
  );
}

function isMachineUpdateReviewBusy(review: MachineUpdatesReview): boolean {
  return review.kind !== 'idle' && review.kind !== 'settled' && review.kind !== 'nothing' && review.kind !== 'failed';
}

export function MachineSecurityView(
  props: Readonly<{
    updates: MachineUpdatesModel;
    machineName: string;
    online: boolean | null;
    controls: MachineSecurityControls;
    /** Installing, restarting and checking need Manage (10-31); a Use grantee reads the pushed facts only. */
    canManage?: boolean;
    /** Happier on this Machine: the Updates surface's own row for it, last in the section. */
    happier?: MachineHappierUpdate | null;
    /** What the Store installed on this Machine (Apps, extensions, plugins…): the Store's own row, last. */
    store?: MachineStoreUpdates | null;
    /** The Machine's Home, for naming what its carried review mentions. */
    serverId?: string | null;
  }>,
) {
  const { updates, controls } = props;
  const { theme } = useUnistyles();
  const canManage = props.canManage ?? true;
  const machine = props.machineName;
  const status = describeUpdatesStatus(updates, machine, props.online, canManage);
  const busy = isMachineUpdateReviewBusy(controls.review);
  const canCheck = props.online === true && !updates.refreshing;
  return (
    <View testID="machine-security">
      <UpdatesFreshness
        updates={updates}
        machineName={machine}
        online={props.online}
        canManage={canManage}
      />
      <ItemGroup
        testID="machine-security-updates-group"
        title={t('machineDetailPage.security.updatesTitle')}
        description={t('machineDetailPage.security.updatesDescription')}
        action={
          updates.stale ? undefined : (
            <TextLinkButton
              testID="machine-security-check-again"
              label={t('machineDetailPage.security.checkAgain')}
              size="meta"
              disabled={!canCheck}
              onPress={() => {
                void updates.refresh();
              }}
            />
          )
        }
      >
        <Item
          testID="machine-security-updates"
          title={status.title}
          icon={<Icon name="shield-check" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
          subtitle={status.subtitle}
          loading={status.loading}
          showChevron={false}
          accessoryLayout="adaptive"
          rightElement={
            status.install && canManage && props.online === true ? (
              <RoundButton
                testID="machine-security-install"
                size="small"
                display="secondary"
                title={t('machineDetailPage.security.installNow')}
                disabled={busy}
                onPress={() => controls.onPrepare(status.install!)}
              />
            ) : undefined
          }
        />
        {updates.observation?.heldPackages?.map(name => (
          <Item
            key={name}
            testID={`machine-security-held-${name}`}
            title={name}
            subtitle={t('machineDetailPage.security.heldPackageReason')}
            icon={<Icon name="lock" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={canManage && props.online === true ? (
              <RoundButton
                testID={`machine-security-release-${name}`}
                size="small"
                display="secondary"
                title={t('machineDetailPage.security.releaseHold')}
                disabled={busy}
                onPress={() => controls.onPrepare('all', { name, operation: 'release' })}
              />
            ) : undefined}
          />
        ))}
        {/* Decided here, not inside the row: the group's child walk counts a row that renders nothing and draws its divider. */}
        {controls.reboot.kind !== 'idle' || updates.rebootNeeded === true ? (
          <RestartRow
            machineName={machine}
            online={props.online}
            controls={controls}
            canManage={canManage}
          />
        ) : null}
        {props.happier ? (
          <UpdateRow
            item={props.happier.item}
            where={machine}
            presentation="screen"
            secondaryAction
            onRun={props.happier.onRun}
            sessionsRunning={props.happier.sessionsRunning}
          />
        ) : null}
        {props.store?.items.map((entry) => (
          // One text column with the rows above it: the Store's row takes this section's row role, not its catalog's.
          <StoreUpdateRow key={entry.key} entry={entry} host={props.store!.host} rowRole="item" testID={`machine-security-store-${entry.key}`} />
        ))}
      </ItemGroup>
      <UpdatesReviewCard machineName={machine} controls={controls} serverId={props.serverId ?? null}
        canHold={canManage && props.online === true} />
    </View>
  );
}

export type MachineHappierUpdate = Readonly<{
  item: UpdateItem;
  onRun: (item: UpdateItem) => void;
  sessionsRunning: boolean;
}>;

export type MachineStoreUpdates = Readonly<{ items: readonly StoreUpdateEntry[]; host: StoreUpdateRowHost }>;

/**
 * This Machine's rows from the one Updates owner, read for this Machine only: Happier's own row
 * (`machines.cli.update`) and what the Store installed here (UPDATES-UNIFY-1113 `group.storeItems`). Decided here,
 * not inside the group: a row that renders nothing would still draw its divider.
 */
function useMachineUpdateRows(machineId: string): Readonly<{ happier: MachineHappierUpdate | null; store: MachineStoreUpdates | null }> {
  const model = useUpdatesContentModel({ machineId });
  const group = model.groups.find((candidate) => candidate.machineId === machineId);
  const item = group?.items.find((candidate) => candidate.subject.kind === 'happier-cli') ?? null;
  const storeItems = group?.storeItems ?? null;
  const sessionsRunning = model.sessionsRunningOn.has(machineId);
  const { runItem } = model;
  const host = useStoreUpdateRowHost(model.storeRows);
  const happier = React.useMemo(
    () => item ? { item, onRun: (next: UpdateItem) => { void runItem(next); }, sessionsRunning } : null,
    [item, runItem, sessionsRunning],
  );
  const store = React.useMemo(() => storeItems && storeItems.length > 0 ? { items: storeItems, host } : null, [host, storeItems]);
  return { happier, store };
}

type UpdatesStatus = Readonly<{
  title: string;
  subtitle?: string;
  loading?: boolean;
  install: MachineUpdatesScope | null;
}>;

/** The one status line: counts the Machine reported, or what it couldn't say. A missing count is never zero. */
export function describeUpdatesStatus(
  updates: MachineUpdatesModel,
  machine: string,
  online: boolean | null,
  canManage = true,
): UpdatesStatus {
  const s = 'machineDetailPage.security' as const;
  const security = updates.pendingSecurity;
  const all = updates.pendingAll;
  // A Use grantee can't ask the Machine; without pushed facts there is nothing to show but who can.
  if (updates.observation === null && !canManage) {
    return { title: t(`${s}.needsManage`, { machine }), install: null };
  }
  if (updates.observation === null) {
    if (
      updates.status === 'unknown' &&
      online === true &&
      updates.read.kind !== 'failed'
    ) {
      return {
        title: t(`${s}.checking`, { machine }),
        loading: true,
        install: null,
      };
    }
    if (online !== true)
      return {
        title: t(`${s}.notCheckedTitle`),
        subtitle: t(`${s}.offlineReason`, { machine }),
        install: null,
      };
    return {
      title: t(`${s}.uncheckedTitle`),
      subtitle: describeReason(updates.reason),
      install: null,
    };
  }
  if (updates.status === 'unsupported') {
    return {
      title: t(`${s}.unsupportedTitle`, { machine }),
      subtitle: t(`${s}.unsupportedReason`),
      install: null,
    };
  }
  if (updates.status === 'drifted' && updates.reason === 'native_effect_failed') {
    return {
      title: t(`${s}.installFailed`, { machine }),
      // Not a failed check: the interrupted install is what Install now reviews and finishes first.
      subtitle: t(`${s}.installUnfinishedReason`),
      install: 'all',
    };
  }
  if (security !== null && security > 0) {
    return {
      title: t(`${s}.securityWaiting`, { count: security }),
      subtitle:
        all !== null && all > security
          ? t(`${s}.inAll`, { count: all })
          : undefined,
      install: 'security',
    };
  }
  if (security === 0) {
    if (all === 0)
      return {
        title: t(`${s}.upToDate`),
        subtitle: t(`${s}.nothingWaiting`),
        install: null,
      };
    if (all !== null)
      return {
        title: t(`${s}.noSecurityWaiting`),
        subtitle: t(`${s}.othersWaiting`, { count: all }),
        install: 'all',
      };
    return {
      title: t(`${s}.noSecurityWaiting`),
      subtitle: t(`${s}.othersUnknown`),
      install: null,
    };
  }
  // The Machine didn't say how many are for security.
  if (all === 0)
    return {
      title: t(`${s}.upToDate`),
      subtitle: t(`${s}.nothingWaiting`),
      install: null,
    };
  if (all !== null)
    return {
      title: t(`${s}.updatesWaiting`, { count: all }),
      subtitle: t(`${s}.securityUnknown`),
      install: 'all',
    };
  if (updates.status === 'unavailable' || updates.status === 'unverifiable') {
    return {
      title: t(`${s}.uncheckedTitle`),
      subtitle: describeReason(updates.reason),
      install: null,
    };
  }
  return {
    title: t(`${s}.countsUnknownTitle`),
    subtitle: t(`${s}.countsUnknown`),
    install: null,
  };
}

/** Setup's own reason copy (one owner with the Setup tab's recipe rows). */
const describeReason = describeMachineSetupReason;

/** Retained counts stay at full strength; one line says why they may be old. */
function UpdatesFreshness(
  props: Readonly<{
    updates: MachineUpdatesModel;
    machineName: string;
    online: boolean | null;
    canManage: boolean;
  }>,
) {
  const { updates } = props;
  if (!updates.stale) return null;
  const s = 'machineDetailPage.security' as const;
  const offline = props.online !== true;
  if (!offline && !props.canManage) {
    return (
      <ItemGroup surface="none">
        <SurfaceFreshnessLine
          testID="machine-security-stale"
          glyph="lock"
          reason={t(`${s}.staleNeedsManage`, { machine: props.machineName })}
        />
      </ItemGroup>
    );
  }
  const unavailable =
    updates.status === 'unavailable' || updates.status === 'unverifiable';
  const reason = offline
    ? t(`${s}.staleOffline`, { machine: props.machineName })
    : updates.refreshing
      ? t(`${s}.staleRefreshing`)
      : unavailable
        ? t(`${s}.staleUnavailable`, { reason: describeReason(updates.reason) })
        : t(`${s}.staleFailed`);
  return (
    <ItemGroup surface="none">
      <SurfaceFreshnessLine
        testID="machine-security-stale"
        reason={reason}
        busy={updates.refreshing}
        tone={!offline && !updates.refreshing ? 'warning' : 'neutral'}
        glyph={offline ? 'cloud-slash' : undefined}
        action={
          offline || updates.refreshing
            ? undefined
            : {
                label: t('machineDetailPage.security.checkAgain'),
                onPress: () => {
                  void updates.refresh();
                },
              }
        }
      />
    </ItemGroup>
  );
}

/** The restart is its own row and its own decision: shown when the Machine says it needs one, or while one runs. */
function RestartRow(
  props: Readonly<{
    machineName: string;
    online: boolean | null;
    controls: MachineSecurityControls;
    canManage: boolean;
  }>,
) {
  const { reboot } = props.controls;
  const machine = props.machineName;
  const { theme } = useUnistyles();
  // Every row in Updates names what it updates with its mark, as the Updates surface's own rows do.
  const restartIcon = <Icon name="arrows-clockwise" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />;
  const s = 'machineDetailPage.security' as const;
  const restartButton = !props.canManage ? undefined : (
    <RoundButton
      testID="machine-security-restart-start"
      size="small"
      display="secondary"
      title={t(`${s}.restart`)}
      disabled={props.online !== true || !props.controls.canReboot}
      loading={reboot.kind === 'starting' && reboot.approval === null}
      onPress={props.controls.onReboot}
    />
  );
  switch (reboot.kind) {
    case 'restarting':
      return (
        <Item
          testID="machine-security-restart"
          icon={restartIcon}
          title={t(`${s}.restartingTitle`, { machine })}
          subtitle={t(`${s}.restartingReason`)}
          loading
          showChevron={false}
          onPress={() => props.controls.onOpenOperation(reboot.operationId)}
        />
      );
    case 'blocked':
      return (
        <Item
          testID="machine-security-restart"
          icon={restartIcon}
          title={t(`${s}.restartBlockedTitle`, { machine })}
          subtitle={t(`${s}.restartBlockedReason`, {
            reasons: joinList(reboot.reasons.map((reason) => t(BLOCKED_KEYS[reason]))),
          })}
          showChevron={false}
          rightElement={restartButton}
          accessoryLayout="adaptive"
        />
      );
    case 'settled':
      return (
        <Item
          testID="machine-security-restart"
          icon={restartIcon}
          title={t(
            reboot.state === 'succeeded'
              ? `${s}.restarted`
              : `${s}.restartFailed`,
            { machine },
          )}
          subtitle={
            reboot.state === 'succeeded'
              ? undefined
              : t(`${s}.restartFailedReason`)
          }
          showChevron={false}
          onPress={() => props.controls.onOpenOperation(reboot.operationId)}
        />
      );
    case 'failed':
      return (
        <Item
          testID="machine-security-restart"
          icon={restartIcon}
          title={t(`${s}.restartFailed`, { machine })}
          subtitle={resolveActionExecutionErrorMessage({ code: reboot.code }, t(`${s}.restartFailedReason`))}
          showChevron={false}
          rightElement={restartButton}
          accessoryLayout="adaptive"
        />
      );
    default:
      return (
        <>
          <Item
            testID="machine-security-restart"
            icon={restartIcon}
            title={t(`${s}.restartNeededTitle`)}
            subtitle={t(
              props.controls.canReboot ? `${s}.restartNeededReason` : `${s}.restartNoInstallation`,
            )}
            showChevron={false}
            rightElement={restartButton}
          accessoryLayout="adaptive"
          />
          {reboot.kind === 'starting' && reboot.approval ? (
            <ActionApprovalPendingNotice
              testID="machine-security-restart-approval"
              message={t(`${s}.restartApproval`)}
              onOpenApproval={() =>
                props.controls.onOpenApproval(reboot.approval!.artifactId)
              }
            />
          ) : null}
        </>
      );
  }
}

const BLOCKED_KEYS = {
  session: 'machineDetailPage.security.blocked.session',
  finite: 'machineDetailPage.security.blocked.finite',
  terminal: 'machineDetailPage.security.blocked.terminal',
  service: 'machineDetailPage.security.blocked.service',
  transfer: 'machineDetailPage.security.blocked.transfer',
  handoff: 'machineDetailPage.security.blocked.handoff',
  sync: 'machineDetailPage.security.blocked.sync',
  setup: 'machineDetailPage.security.blocked.setup',
  input: 'machineDetailPage.security.blocked.input',
  execution_run: 'machineDetailPage.security.blocked.executionRun',
  workflow_run: 'machineDetailPage.security.blocked.workflowRun',
  agents: 'machineDetailPage.security.blocked.agents',
  attention: 'machineDetailPage.security.blocked.attention',
  coverage_unknown: 'machineDetailPage.security.blocked.coverageUnknown',
} as const;

/** The reviewed install opens under the section: exactly what the Machine planned, then its own progress. */
function UpdatesReviewCard(
  props: Readonly<{ machineName: string; controls: MachineSecurityControls; serverId: string | null; canHold: boolean }>,
) {
  const { review } = props.controls;
  const machine = props.machineName;
  const s = 'machineDetailPage.security' as const;
  const hold = review.kind === 'idle' ? undefined : review.hold;
  const holdLabel = hold ? t(hold.operation === 'hold' ? `${s}.holdPackage` : `${s}.releaseHold`) : null;
  switch (review.kind) {
    case 'idle':
      return null;
    case 'nothing':
      return (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machine-security-nothing"
            kind="success"
            layout="inline"
            size="line"
            title={t(`${s}.nothingToInstall`, { machine })}
            secondaryAction={{
              label: t('common.close'),
              onPress: props.controls.onCancel,
            }}
          />
        </ItemGroup>
      );
    case 'failed':
      return (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machine-security-review-failed"
            kind="error"
            layout="inline"
            title={hold ? t(`${s}.packageHoldFailed`, { name: hold.name }) : t(
              review.during === 'apply'
                ? `${s}.applyFailed`
                : `${s}.prepareFailed`,
              { machine },
            )}
            diagnosticCode={review.failure.errorCode}
            action={{
              label: t('common.retry'),
              onPress: () => hold ? props.controls.onPrepare(review.scope, hold) : props.controls.onPrepare(review.scope),
            }}
            secondaryAction={{
              label: t('common.cancel'),
              onPress: props.controls.onCancel,
            }}
          />
        </ItemGroup>
      );
    case 'installing':
      return (
        <ItemGroup
          testID="machine-security-installing"
          title={holdLabel ?? t(`${s}.installingTitle`, { count: review.count })}
        >
          <Item
            testID="machine-security-installing-row"
            title={hold?.name ?? t(`${s}.installingRow`, { machine })}
            loading
            showChevron={false}
            onPress={() => props.controls.onOpenOperation(review.operationId)}
          />
        </ItemGroup>
      );
    case 'settled': {
      const fallback = hold
        ? t(review.state === 'succeeded' ? `${s}.packageHoldChanged` : `${s}.packageHoldFailed`, { name: hold.name })
        : t(review.state === 'succeeded' ? `${s}.installed` : `${s}.installFailed`, { machine });
      const title = resolveMachineAvailabilityReasonCopy(review.failure?.errorCode, machine)
        ?? resolveActionExecutionErrorMessage(review.failure, fallback, { closedCodesOnly: true });
      return (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machine-security-installed"
            kind={review.state === 'succeeded' ? 'success' : 'error'}
            layout="inline"
            size="line"
            title={title}
            diagnosticCode={review.failure?.errorCode}
            action={{
              label: t(`${s}.showDetails`),
              onPress: () => props.controls.onOpenOperation(review.operationId),
            }}
            secondaryAction={{
              label: t('common.close'),
              onPress: props.controls.onCancel,
            }}
          />
        </ItemGroup>
      );
    }
    default: {
      const approval = review.kind === 'review' ? null : review.approval;
      // The Machine's own review of this install: this step is its confirmation, so Install answers it.
      const confirmation = review.kind === 'applying' ? review.confirmation : null;
      const packages = review.kind === 'preparing' ? [] : review.packages;
      const prerequisite = review.kind === 'review'
        ? describeActionExecutionPrerequisite(review.setupReview?.administratorUnavailable?.reasonCode)
        : null;
      return (
        <>
        <ItemGroup
          testID="machine-security-review-card"
          title={holdLabel ?? t(
            review.scope === 'security'
              ? `${s}.reviewTitleSecurity`
              : `${s}.reviewTitleAll`,
            { machine },
          )}
          description={prerequisite?.message ?? confirmation?.summary ?? (hold
            ? (hold.operation === 'hold' ? t(`${s}.heldPackageReason`) : undefined)
            : t(`${s}.reviewDescription`))}
        >
          {review.kind === 'preparing' ? (
            <Item
              testID="machine-security-preparing"
              title={t(`${s}.preparing`, { machine })}
              loading
              showChevron={false}
            />
          ) : hold ? (
            <Item title={hold.name} showChevron={false} />
          ) : (
            packages.map((item) => (
              <Item
                key={item.name}
                testID={`machine-security-package-${item.name}`}
                title={item.name}
                detail={item.version ?? undefined}
                showChevron={false}
                accessoryLayout="adaptive"
                rightElement={props.canHold && review.kind === 'review' && review.canHold && item.version !== null ? (
                  <RoundButton
                    testID={`machine-security-hold-${item.name}`}
                    size="small"
                    display="secondary"
                    title={t(`${s}.holdPackage`)}
                    onPress={() => props.controls.onPrepare(review.scope, { name: item.name, operation: 'hold' })}
                  />
                ) : undefined}
              />
            ))
          )}
          {approval ? (
            <ActionApprovalPendingNotice
              testID="machine-security-approval"
              message={t(`${s}.approvalWaiting`)}
              onOpenApproval={() =>
                props.controls.onOpenApproval(approval.artifactId)
              }
            />
          ) : null}
        </ItemGroup>
        {confirmation ? (
          <ActionConfirmationReviewFacts actionId={confirmation.actionId} actionArgs={confirmation.actionArgs}
            summaryPlacement="host"
            preview={confirmation.preview} serverId={props.serverId} testID="machine-security-confirmation" />
        ) : null}
        {/* The decision sits after the review's sheet (SectionButtonRow contract), not inside it. */}
        <ItemGroup surface="none">
          <SectionButtonRow>
            <RoundButton
              testID="machine-security-apply"
              size="small"
              title={holdLabel ?? t(`${s}.installCount`, { count: packages.length })}
              disabled={(review.kind !== 'review' && !confirmation) || prerequisite !== null}
              {...(prerequisite ? { accessibilityHint: prerequisite.message } : {})}
              loading={review.kind === 'applying' && approval === null && !confirmation}
              onPress={props.controls.onApply}
            />
            <RoundButton
              testID="machine-security-cancel"
              size="small"
              display="secondary"
              title={t('common.cancel')}
              onPress={props.controls.onCancel}
            />
          </SectionButtonRow>
        </ItemGroup>
        </>
      );
    }
  }
}

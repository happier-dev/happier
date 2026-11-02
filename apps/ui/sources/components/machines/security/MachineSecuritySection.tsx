import * as React from 'react';
import { View } from 'react-native';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

import type { MachineUpdatesScope } from './machineUpdatesActions';
import {
  useMachineSecurityReboot,
  type MachineSecurityReboot,
} from './useMachineSecurityReboot';
import { useMachineUpdates } from './useMachineUpdates';
import {
  useMachineUpdatesReview,
  type MachineUpdatesReview,
} from './useMachineUpdatesReview';

export type MachineUpdatesModel = ReturnType<typeof useMachineUpdates>;

export type MachineSecurityControls = Readonly<{
  review: MachineUpdatesReview;
  onPrepare: (scope: MachineUpdatesScope) => void;
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
  }>,
) {
  const router = useRouter();
  const updates = useMachineUpdates({
    serverId: props.serverId,
    machineId: props.machineId,
    enabled: true,
    reachable: props.online,
  });
  const { refresh } = updates;
  const onSettled = React.useCallback(() => {
    void refresh();
  }, [refresh]);
  const updatesReview = useMachineUpdatesReview({
    serverId: props.serverId,
    machineId: props.machineId,
    onSettled,
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
    onPrepare: (scope) => {
      void prepare(scope);
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
  return (
    <MachineSecurityView
      updates={updates}
      machineName={props.machineName}
      online={props.online}
      controls={controls}
    />
  );
}

export function MachineSecurityView(
  props: Readonly<{
    updates: MachineUpdatesModel;
    machineName: string;
    online: boolean | null;
    controls: MachineSecurityControls;
  }>,
) {
  const { updates, controls } = props;
  const machine = props.machineName;
  const status = describeUpdatesStatus(updates, machine, props.online);
  const busy =
    controls.review.kind !== 'idle' &&
    controls.review.kind !== 'settled' &&
    controls.review.kind !== 'nothing' &&
    controls.review.kind !== 'failed';
  const canCheck = props.online === true && !updates.refreshing;
  return (
    <View testID="machine-security">
      <UpdatesFreshness
        updates={updates}
        machineName={machine}
        online={props.online}
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
          subtitle={status.subtitle}
          loading={status.loading}
          showChevron={false}
          rightElement={
            status.install && props.online === true ? (
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
        <RestartRow
          updates={updates}
          machineName={machine}
          online={props.online}
          controls={controls}
        />
      </ItemGroup>
      <UpdatesReviewCard machineName={machine} controls={controls} />
    </View>
  );
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
): UpdatesStatus {
  const s = 'machineDetailPage.security' as const;
  const security = updates.pendingSecurity;
  const all = updates.pendingAll;
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

const REASON_KEYS = {
  required_fact_unavailable:
    'machineDetailPage.security.reasons.requiredFactUnavailable',
  needs_admin_to_check: 'machineDetailPage.security.reasons.needsAdminToCheck',
  package_manager_busy: 'machineDetailPage.security.reasons.packageManagerBusy',
  foreign_effect_conflict:
    'machineDetailPage.security.reasons.foreignEffectConflict',
  private_scope_unenforceable: 'machineDetailPage.security.reasons.checkFailed',
  remove_unsupported: 'machineDetailPage.security.reasons.checkFailed',
  plan_changed: 'machineDetailPage.security.reasons.planChanged',
  validation_failed: 'machineDetailPage.security.reasons.checkFailed',
  native_effect_failed: 'machineDetailPage.security.reasons.checkFailed',
  admin_access_unavailable:
    'machineDetailPage.security.reasons.adminAccessUnavailable',
} as const;

function describeReason(reason: MachineUpdatesModel['reason']): string {
  return t(
    reason
      ? REASON_KEYS[reason]
      : 'machineDetailPage.security.reasons.checkFailed',
  );
}

/** Retained counts stay at full strength; one line says why they may be old. */
function UpdatesFreshness(
  props: Readonly<{
    updates: MachineUpdatesModel;
    machineName: string;
    online: boolean | null;
  }>,
) {
  const { updates } = props;
  if (!updates.stale) return null;
  const s = 'machineDetailPage.security' as const;
  const offline = props.online !== true;
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
    updates: MachineUpdatesModel;
    machineName: string;
    online: boolean | null;
    controls: MachineSecurityControls;
  }>,
) {
  const { reboot } = props.controls;
  const machine = props.machineName;
  const s = 'machineDetailPage.security' as const;
  if (reboot.kind === 'idle' && props.updates.rebootNeeded !== true)
    return null;
  const restartButton = (
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
          title={t(`${s}.restartBlockedTitle`, { machine })}
          subtitle={t(`${s}.restartBlockedReason`, {
            reasons: joinList(reboot.reasons.map((reason) => t(BLOCKED_KEYS[reason]))),
          })}
          showChevron={false}
          rightElement={restartButton}
        />
      );
    case 'settled':
      return (
        <Item
          testID="machine-security-restart"
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
          title={t(`${s}.restartFailed`, { machine })}
          subtitle={t(`${s}.restartFailedReason`)}
          showChevron={false}
          rightElement={restartButton}
        />
      );
    default:
      return (
        <>
          <Item
            testID="machine-security-restart"
            title={t(`${s}.restartNeededTitle`)}
            subtitle={t(
              props.controls.canReboot ? `${s}.restartNeededReason` : `${s}.restartNoInstallation`,
            )}
            showChevron={false}
            rightElement={restartButton}
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
  props: Readonly<{ machineName: string; controls: MachineSecurityControls }>,
) {
  const { review } = props.controls;
  const machine = props.machineName;
  const s = 'machineDetailPage.security' as const;
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
            title={t(
              review.during === 'apply'
                ? `${s}.applyFailed`
                : `${s}.prepareFailed`,
              { machine },
            )}
            diagnosticCode={review.failure.errorCode}
            action={{
              label: t('common.retry'),
              onPress: () => props.controls.onPrepare(review.scope),
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
          title={t(`${s}.installingTitle`, { count: review.count })}
        >
          <Item
            testID="machine-security-installing-row"
            title={t(`${s}.installingRow`, { machine })}
            loading
            showChevron={false}
            onPress={() => props.controls.onOpenOperation(review.operationId)}
          />
        </ItemGroup>
      );
    case 'settled':
      return (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machine-security-installed"
            kind={review.state === 'succeeded' ? 'success' : 'error'}
            layout="inline"
            size="line"
            title={t(
              review.state === 'succeeded'
                ? `${s}.installed`
                : `${s}.installFailed`,
              { machine },
            )}
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
    default: {
      const approval = review.kind === 'review' ? null : review.approval;
      const packages = review.kind === 'preparing' ? [] : review.packages;
      return (
        <>
        <ItemGroup
          testID="machine-security-review-card"
          title={t(
            review.scope === 'security'
              ? `${s}.reviewTitleSecurity`
              : `${s}.reviewTitleAll`,
            { machine },
          )}
          description={t(`${s}.reviewDescription`)}
        >
          {review.kind === 'preparing' ? (
            <Item
              testID="machine-security-preparing"
              title={t(`${s}.preparing`, { machine })}
              loading
              showChevron={false}
            />
          ) : (
            packages.map((item) => (
              <Item
                key={item.name}
                testID={`machine-security-package-${item.name}`}
                title={item.name}
                detail={item.version ?? undefined}
                showChevron={false}
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
        {/* The decision sits after the review's sheet (SectionButtonRow contract), not inside it. */}
        <ItemGroup surface="none">
          <SectionButtonRow>
            <RoundButton
              testID="machine-security-apply"
              size="small"
              title={t(`${s}.installCount`, { count: packages.length })}
              disabled={review.kind !== 'review'}
              loading={review.kind === 'applying' && approval === null}
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

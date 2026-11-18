import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import {
  MachineAgentIsolationPreviewResultV1Schema,
  MachineAgentIsolationSetResultV1Schema,
  type MachineAgentIsolationPreviewResultV1,
  type MachineAgentIsolationStatusV1,
} from '@happier-dev/protocol/machines/agentIsolationV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectWorkspaceForgetOutputV1Schema } from '@happier-dev/protocol/projects/projectWorkspaceActionsV1';
import type { MachineElevatedNotAppliedResultV1 } from '@happier-dev/protocol/machines/adminAccessV1';

import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AgentIsolationEffectsGroup } from '@/components/inbox/actionOperations/agentIsolationEffects';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { MachineAgentRunAs, useMachineGuestExecution } from '@/hooks/machine/useMachineGuestExecution';
import { t } from '@/text';
import { resolveActionTitle } from '@/text/actionTitles';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';

type ReadyPreview = Extract<
  MachineAgentIsolationPreviewResultV1,
  { kind: 'ready' }
>;

function setupFailureMessage(setup: MachineElevatedNotAppliedResultV1 | undefined, fallback: string): string {
  if (setup?.reasonCode === 'mode_none') return t('machines.sharing.fallback.adminDisabled');
  if (setup?.reasonCode === 'not_preauthorized') return t('machines.sharing.fallback.adminCheckRequired');
  if (setup?.reasonCode === 'managed_cli_unavailable') return t('machines.sharing.fallback.managedCliRequired');
  return setup ? resolveActionExecutionErrorMessage({ code: setup.reasonCode, failure: setup.failure }, fallback) : fallback;
}

function daemonGroupRefreshMessage(status: MachineAgentIsolationStatusV1): string | undefined {
  const prerequisite = status.kind === 'unavailable' ? status.prerequisite : undefined;
  if (prerequisite?.reason === 'native_effect_pending' && prerequisite.requiredFact === 'daemon_group_refresh') {
    return prerequisite.detail;
  }
}

type Phase = Readonly<
  | { kind: 'offer' }
  | { kind: 'previewing' }
  | { kind: 'review'; preview: ReadyPreview }
  | { kind: 'applying'; preview: ReadyPreview }
  | {
      kind: 'settled';
      tone: 'loading';
      message: string;
      operationId: string;
      reviewAgain?: never;
    }
  | {
      kind: 'settled';
      tone: 'success' | 'warning' | 'error' | 'unavailable';
      message: string;
      reviewAgain?: boolean;
      workspaceFailure?: Extract<MachineAgentIsolationPreviewResultV1, { kind: 'unavailable' }>['workspaceFailure'];
      forgettingWorkspace?: boolean;
      recoveryError?: string;
    }
  | { kind: 'approval'; artifactId: string }
>;

/**
 * One reviewed change of how agents run on a Machine (a user per person, the shared agent user, or
 * Happier's own user): preview → the person's review → their own confirmation → the owner's typed
 * result. The existing setup, approval and operation owners do the rest, so this only keeps the
 * person's step and words the typed results.
 */
export function useSeparateUsersChange(
  input: Readonly<{
    machine: string;
    guestExecution: ReturnType<typeof useMachineGuestExecution>;
    target: MachineAgentRunAs;
  }>,
) {
  const { machine, guestExecution, target } = input;
  // Separate users keep their own words where they are offered (Sharing); the other targets say the change.
  const member = target === 'member';
  const [phase, setPhase] = React.useState<Phase>({ kind: 'offer' });
  const lifetime = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => lifetime.current?.abort(), []);

  // Admission is not completion. The existing operation push owns the end of
  // this message; current Machine facts already own the selected policy and readiness.
  const operationId = phase.kind === 'settled' && phase.tone === 'loading' ? phase.operationId : null;
  const operation = useActionOperation({
    serverId: operationId ? guestExecution.serverId : null,
    operationId: operationId ?? '',
  });
  const operationState = operation?.snapshot.state;
  const operationError = operation?.snapshot.error;
  React.useEffect(() => {
    if (!operationId || !operationState || !isActionOperationTerminal(operationState)) return;
    setPhase(operationState === 'failed'
      ? { kind: 'settled', tone: 'error', message: resolveActionExecutionErrorMessage(operationError,
          member ? t('machines.sharing.fallback.failed') : t('machineDetailPage.security.admin.agentsRunAsFailed')) }
      : { kind: 'offer' });
  }, [member, operationError, operationId, operationState]);

  const review = React.useCallback(async () => {
    lifetime.current?.abort();
    const controller = new AbortController();
    lifetime.current = controller;
    setPhase({ kind: 'previewing' });
    const result = await guestExecution
      .previewSeparateUsers(controller.signal, target)
      .catch(() => null);
    if (controller.signal.aborted) return;
    const preview = result?.ok
      ? MachineAgentIsolationPreviewResultV1Schema.safeParse(result.result)
      : null;
    if (preview?.success && preview.data.kind === 'ready')
      setPhase({ kind: 'review', preview: preview.data });
    else if (preview?.success && preview.data.kind === 'unavailable') {
      const { status, setup, workspaceFailure } = preview.data;
      const fallback = t(`machines.sharing.fallback.prerequisites.${status.code}`);
      const message = workspaceFailure
        ? t(workspaceFailure.code === 'ENOENT' ? 'errors.machineIsolationWorkspaceMissing' : 'errors.machineIsolationWorkspaceUnavailable',
            { path: workspaceFailure.path })
        : setupFailureMessage(setup, fallback);
      setPhase({ kind: 'settled', tone: 'unavailable', message, workspaceFailure });
    } else
      setPhase({
        kind: 'settled',
        tone: 'unavailable',
        message: resolveActionExecutionErrorMessage(result,
          t('machines.sharing.fallback.unavailable', { machine })),
      });
  }, [guestExecution, machine, target]);

  const apply = React.useCallback(
    async (preview: ReadyPreview) => {
      setPhase({ kind: 'applying', preview });
      // Confirmation admits finite setup. Its own policy publication can
      // retire this offer while the Machine still owns the operation.
      const failed = member
        ? t('machines.sharing.fallback.failed')
        : t('machineDetailPage.security.admin.agentsRunAsFailed');
      const result = await guestExecution
        .applySeparateUsers(preview, undefined, target)
        .catch(() => null);
      if (!result?.ok) {
        setPhase({ kind: 'settled', tone: 'error', message: resolveActionExecutionErrorMessage(result, failed) });
        return;
      }
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(
        result.result,
      );
      if (approval.success) {
        setPhase({ kind: 'approval', artifactId: approval.data.artifactId });
        return;
      }
      const settled = MachineAgentIsolationSetResultV1Schema.safeParse(
        result.result,
      );
      if (!settled.success) {
        setPhase({ kind: 'settled', tone: 'error', message: failed });
        return;
      }
      const value = settled.data;
      // Each typed result keeps its own recovery: a changed plan is reviewed again, never re-applied blind.
      if ((value.kind === 'accepted' || value.kind === 'unchanged') && value.status.kind === 'unavailable') {
        const message = daemonGroupRefreshMessage(value.status);
        setPhase({
          kind: 'settled',
          tone: 'unavailable',
          message: message ?? t(`machines.sharing.fallback.prerequisites.${value.status.code}`),
          ...(message ? { reviewAgain: true } : {}),
        });
      } else if (value.kind === 'accepted')
        setPhase({
          kind: 'settled',
          tone: 'loading',
          operationId: value.operationId,
          message: member
            ? t('machines.sharing.fallback.applying', { machine })
            : t('machineDetailPage.security.admin.agentsRunAsChanging', { machine }),
        });
      else if (value.kind === 'unchanged')
        setPhase({
          kind: 'settled',
          tone: 'success',
          message: member
            ? t('machines.sharing.fallback.alreadyOn')
            : t('machineDetailPage.security.admin.agentsRunAsUnchanged'),
        });
      else if (value.kind === 'plan_changed' || value.kind === 'conflict')
        setPhase({
          kind: 'settled',
          tone: 'warning',
          message: t('machines.sharing.fallback.changed', { machine }),
          reviewAgain: true,
        });
      else if (value.code === 'cancelled') setPhase({ kind: 'offer' });
      else
        setPhase({
          kind: 'settled',
          tone: value.code === 'outcome_unknown' ? 'warning' : 'error',
          reviewAgain: value.code === 'outcome_unknown',
          message:
            value.code === 'outcome_unknown'
              ? t('machines.sharing.fallback.unknown', { machine })
              : value.code === 'locked'
                ? t('machines.sharing.fallback.locked', { machine })
                : setupFailureMessage(value.setup, failed),
        });
    },
    [guestExecution, machine, member, target],
  );

  const reset = React.useCallback(() => {
    lifetime.current?.abort();
    setPhase({ kind: 'offer' });
  }, []);
  const forgetWorkspace = React.useCallback(async () => {
    if (phase.kind !== 'settled' || phase.tone === 'loading' || !phase.workspaceFailure || phase.forgettingWorkspace) return;
    const previous = phase;
    setPhase({ ...previous, forgettingWorkspace: true });
    const result = await guestExecution.forgetWorkspace(phase.workspaceFailure.workspaceId).catch(() => null);
    const approval = result?.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
    if (approval?.success) {
      setPhase({ kind: 'approval', artifactId: approval.data.artifactId });
      return;
    }
    const forgotten = result?.ok ? ProjectWorkspaceForgetOutputV1Schema.safeParse(result.result) : null;
    if (forgotten?.success && forgotten.data.ok) reset();
    else setPhase({ ...previous, forgettingWorkspace: false,
      recoveryError: resolveActionExecutionErrorMessage(result?.ok ? result.result : result, t('errors.operationFailed')) });
  }, [guestExecution, phase, reset]);
  return { phase, target, enabled: target !== 'daemon', review, apply, reset, forgetWorkspace };
}

export type SeparateUsersChange = ReturnType<typeof useSeparateUsersChange>;

const CONFIRM_KEYS = {
  member: 'machineDetailPage.security.admin.agentsRunAsConfirmMember',
  sharedAgent: 'machineDetailPage.security.admin.agentsRunAsConfirmShared',
  daemon: 'machineDetailPage.security.admin.agentsRunAsConfirmDaemon',
} as const satisfies Record<MachineAgentRunAs, string>;

const REVIEW_TITLE_KEYS = {
  member: 'machineDetailPage.security.admin.agentsRunAsReviewMember',
  sharedAgent: 'machineDetailPage.security.admin.agentsRunAsReviewShared',
  daemon: 'machineDetailPage.security.admin.agentsRunAsReviewDaemon',
} as const satisfies Record<MachineAgentRunAs, string>;

/**
 * The change's step after the choice: checking, the reviewed effects with Cancel and the named confirm,
 * the waiting approval, or the result with its one next action. Renders nothing while only offered.
 * This is the one review of how agents run (Security); Sharing's offer leads here instead of drawing its own.
 */
export function SeparateUsersChangeStep(
  props: Readonly<{
    change: SeparateUsersChange;
    machine: string;
    testID: string;
    openApproval?: (artifactId: string) => void;
  }>,
) {
  const { change, machine, testID } = props;
  const { phase } = change;
  const wrap = (node: React.ReactNode) => <ItemGroup surface="none">{node}</ItemGroup>;
  if (phase.kind === 'offer') return null;
  if (phase.kind === 'previewing')
    return wrap(
      <SurfaceStateCard
        kind="loading"
        size="line"
        testID={`${testID}-previewing`}
        accessibilitySemantics="status"
        title={t('machines.sharing.fallback.previewing', { machine })}
      />,
    );
  if (phase.kind === 'review' || phase.kind === 'applying') {
    const preview = phase.preview;
    const applying = phase.kind === 'applying';
    return (
      <View testID={`${testID}-review`}>
        <AgentIsolationEffectsGroup
          enabled={change.enabled}
          plan={preview.plan}
          metadataVersion={preview.metadataVersion}
          title={t(REVIEW_TITLE_KEYS[change.target], { machine })}
        />
        <ItemGroup surface="none">
          <RoundButtonSizeScope size="small">
            <View style={styles.sectionActions}>
              <RoundButton
                testID={`${testID}-cancel`}
                display="secondary"
                title={t('common.cancel')}
                disabled={applying}
                onPress={change.reset}
              />
              <RoundButton
                testID={`${testID}-confirm`}
                title={t(CONFIRM_KEYS[change.target])}
                loading={applying}
                disabled={applying}
                onPress={() => {
                  void change.apply(preview);
                }}
              />
            </View>
          </RoundButtonSizeScope>
        </ItemGroup>
      </View>
    );
  }
  if (phase.kind === 'approval')
    return wrap(
      <SurfaceStateCard
        kind="warning"
        size="line"
        testID={`${testID}-approval`}
        title={t('machines.sharing.fallback.approval')}
        {...(props.openApproval
          ? {
              action: {
                label: t('approvals.details'),
                onPress: () => props.openApproval?.(phase.artifactId),
              },
            }
          : {})}
      />,
    );
  const recovery = phase.tone === 'loading' ? null : phase;
  return wrap(
    <SurfaceStateCard
      kind={phase.tone}
      size="line"
      testID={`${testID}-result`}
      title={phase.message}
      {...(recovery?.recoveryError ? { detail: recovery.recoveryError } : {})}
      {...(recovery?.workspaceFailure
        ? { reason: t('errors.machineIsolationWorkspaceRecovery') } : {})}
      accessibilitySemantics="status"
      {...(phase.reviewAgain ||
      phase.tone === 'error' ||
      phase.tone === 'unavailable'
        ? {
            action: {
              disabled: recovery?.forgettingWorkspace,
              label: phase.reviewAgain
                ? t('machines.sharing.fallback.reviewAgain')
                : t('common.retry'),
              onPress: () => {
                void change.review();
              },
            },
          }
        : {})}
      {...(phase.reviewAgain || phase.tone === 'success' || phase.tone === 'unavailable' || phase.tone === 'error'
        ? { secondaryAction: recovery?.workspaceFailure
            ? { label: resolveActionTitle('projects.workspace.forget', null), onPress: change.forgetWorkspace,
                busy: recovery.forgettingWorkspace }
            : { label: t('common.close'), onPress: change.reset } }
        : {})}
    />,
  );
}

/**
 * The Linux owner's way out of the fallback, said under the trust line it answers: separate users give
 * each person their own operating-system user. How agents run is one choice with one review, in the
 * Machine's Security tab; this offer leads there.
 */
export function MachineSeparateUsersOffer(
  props: Readonly<{
    machine: string;
    guestExecution: ReturnType<typeof useMachineGuestExecution>;
    idPrefix: string;
  }>,
) {
  const router = useRouter();
  const door = useMachinesDoor();
  const { machineId, serverId } = props.guestExecution;
  const testID = `${props.idPrefix}machine-share-separate-users`;
  return (
    <View style={styles.block} testID={testID}>
      <Text style={styles.line}>{t('machines.sharing.fallback.offer', { machine: props.machine })}</Text>
      {/* The same quiet bordered button the Secrets row operations use. */}
      <View style={styles.actions}>
        <RoundButton
          size="small"
          display="secondary"
          title={t('machines.sharing.fallback.turnOn')}
          testID={`${testID}-turn-on`}
          onPress={() => router.push(machinePageHref({
            door,
            target: { machineId, ...(serverId ? { serverId } : {}) },
            tab: { id: 'security' },
          }) as never)}
        />
      </View>
    </View>
  );
}

// The offer reads as the trust line's second sentence: same column, row-description type.
const styles = StyleSheet.create((theme) => ({
  block: {
    gap: theme.space.s6,
  },
  line: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingTop: theme.space.s4,
  },
  // A section's decision sits after its sheet, trailing, the way the review's own buttons do.
  sectionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
}));

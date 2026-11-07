import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import {
  MachineAgentIsolationPreviewResultV1Schema,
  MachineAgentIsolationSetResultV1Schema,
  type MachineAgentIsolationPreviewResultV1,
} from '@happier-dev/protocol/machines/agentIsolationV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  AgentIsolationEffectsGroup,
  describeAgentIsolationEffects,
} from '@/components/inbox/actionOperations/agentIsolationEffects';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { MachineAgentRunAs, useMachineGuestExecution } from '@/hooks/machine/useMachineGuestExecution';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

type ReadyPreview = Extract<
  MachineAgentIsolationPreviewResultV1,
  { kind: 'ready' }
>;
type Phase = Readonly<
  | { kind: 'offer' }
  | { kind: 'previewing' }
  | { kind: 'review'; preview: ReadyPreview }
  | { kind: 'applying'; preview: ReadyPreview }
  | {
      kind: 'settled';
      tone: 'loading' | 'success' | 'warning' | 'error' | 'unavailable';
      message: string;
      reviewAgain?: boolean;
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
      const { status, setup } = preview.data;
      const fallback = t(`machines.sharing.fallback.prerequisites.${status.code}`);
      const message = setup?.reasonCode === 'mode_none'
        ? t('machines.sharing.fallback.adminDisabled')
        : setup?.reasonCode === 'not_preauthorized'
          ? t('machines.sharing.fallback.adminCheckRequired')
          : setup?.reasonCode === 'managed_cli_unavailable'
            ? t('machines.sharing.fallback.managedCliRequired')
            : setup ? resolveActionExecutionErrorMessage({ code: setup.reasonCode }, fallback) : fallback;
      setPhase({ kind: 'settled', tone: 'unavailable', message });
    } else
      setPhase({
        kind: 'settled',
        tone: 'unavailable',
        message: t('machines.sharing.fallback.unavailable', { machine }),
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
        setPhase({ kind: 'settled', tone: 'error', message: failed });
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
      if (value.kind === 'accepted')
        setPhase({
          kind: 'settled',
          tone: 'loading',
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
          message:
            value.code === 'outcome_unknown'
              ? t('machines.sharing.fallback.unknown', { machine })
              : value.code === 'locked'
                ? t('machines.sharing.fallback.locked', { machine })
                : failed,
        });
    },
    [guestExecution, machine, member, target],
  );

  const reset = React.useCallback(() => {
    lifetime.current?.abort();
    setPhase({ kind: 'offer' });
  }, []);
  return { phase, target, enabled: target !== 'daemon', review, apply, reset };
}

export type SeparateUsersChange = ReturnType<typeof useSeparateUsersChange>;

const REVIEW_TITLE_KEYS = {
  member: 'machineDetailPage.security.admin.agentsRunAsReviewMember',
  sharedAgent: 'machineDetailPage.security.admin.agentsRunAsReviewShared',
  daemon: 'machineDetailPage.security.admin.agentsRunAsReviewDaemon',
} as const satisfies Record<MachineAgentRunAs, string>;

/**
 * The change's step after the offer: checking, the reviewed effects with Cancel and the confirm, the
 * waiting approval, or the result with its one next action. Renders nothing while only offered.
 * `section`: a page section of its own (the Security tab); `inline`: lines under the trust line it
 * answers (Sharing). Both say the same effects, from `describeAgentIsolationEffects`.
 */
export function SeparateUsersChangeStep(
  props: Readonly<{
    change: SeparateUsersChange;
    machine: string;
    testID: string;
    presentation: 'inline' | 'section';
    openApproval?: (artifactId: string) => void;
  }>,
) {
  const { change, machine, testID } = props;
  const { phase } = change;
  const section = props.presentation === 'section';
  const wrap = (node: React.ReactNode) => section
    ? <ItemGroup surface="none">{node}</ItemGroup>
    : <View style={styles.block} testID={testID}>{node}</View>;
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
    const actions = (
      <RoundButtonSizeScope size="small">
        <View style={section ? styles.sectionActions : styles.actions}>
          <RoundButton
            testID={`${testID}-cancel`}
            display="secondary"
            title={t('common.cancel')}
            disabled={applying}
            onPress={change.reset}
          />
          <RoundButton
            testID={`${testID}-confirm`}
            title={change.target === 'member'
              ? t('machines.sharing.fallback.confirm')
              : t('machineDetailPage.security.admin.agentsRunAsConfirm')}
            loading={applying}
            disabled={applying}
            onPress={() => {
              void change.apply(preview);
            }}
          />
        </View>
      </RoundButtonSizeScope>
    );
    if (section)
      return (
        <View testID={`${testID}-review`}>
          <AgentIsolationEffectsGroup
            enabled={change.enabled}
            plan={preview.plan}
            metadataVersion={preview.metadataVersion}
            title={t(REVIEW_TITLE_KEYS[change.target], { machine })}
          />
          <ItemGroup surface="none">{actions}</ItemGroup>
        </View>
      );
    const effects = describeAgentIsolationEffects(change.enabled, preview.plan)
      .filter((effect) => effect.key !== 'policy');
    return (
      <View style={styles.block} testID={`${testID}-review`}>
        {effects.map((effect) => (
          <Text key={effect.key} style={styles.line}>
            <Text style={styles.lineTitle}>
              {effect.count !== undefined ? `${effect.title} · ${effect.count}` : effect.title}
            </Text>
            {effect.hint ? ` ${effect.hint}` : null}
          </Text>
        ))}
        {actions}
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
  return wrap(
    <SurfaceStateCard
      kind={phase.tone}
      size="line"
      testID={`${testID}-result`}
      title={phase.message}
      accessibilitySemantics="status"
      {...(phase.reviewAgain ||
      phase.tone === 'error' ||
      phase.tone === 'unavailable'
        ? {
            action: {
              label: phase.reviewAgain
                ? t('machines.sharing.fallback.reviewAgain')
                : t('common.retry'),
              onPress: () => {
                void change.review();
              },
            },
          }
        : {})}
      {...(phase.tone === 'success' || phase.tone === 'unavailable' || phase.tone === 'error'
        ? { secondaryAction: { label: t('common.close'), onPress: change.reset } }
        : {})}
    />,
  );
}

/**
 * The Linux owner's way out of the fallback, said under the trust line it answers: separate users give
 * each person their own operating-system user. Turning them on shows the reviewed effects first and
 * applies only on the person's own confirmation.
 */
export function MachineSeparateUsersOffer(
  props: Readonly<{
    machine: string;
    guestExecution: ReturnType<typeof useMachineGuestExecution>;
    idPrefix: string;
    openApproval?: (artifactId: string) => void;
  }>,
) {
  const { machine, guestExecution, idPrefix } = props;
  const change = useSeparateUsersChange({ machine, guestExecution, target: 'member' });
  const testID = `${idPrefix}machine-share-separate-users`;
  if (change.phase.kind === 'offer')
    return (
      <View style={styles.block} testID={testID}>
        <Text style={styles.line}>
          {t('machines.sharing.fallback.offer', { machine })}
        </Text>
        {/* The same quiet bordered button the review step and the Secrets row operations use. */}
        <View style={styles.actions}>
          <RoundButton
            size="small"
            display="secondary"
            title={t('machines.sharing.fallback.turnOn')}
            testID={`${testID}-turn-on`}
            onPress={() => {
              void change.review();
            }}
          />
        </View>
      </View>
    );
  return (
    <SeparateUsersChangeStep
      change={change}
      machine={machine}
      testID={testID}
      presentation="inline"
      {...(props.openApproval ? { openApproval: props.openApproval } : {})}
    />
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
  lineTitle: {
    color: theme.colors.text.primary,
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

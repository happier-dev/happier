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
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { useMachineGuestExecution } from '@/hooks/machine/useMachineGuestExecution';
import { t } from '@/text';

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
 * The Linux owner's way out of the fallback, said under the trust line it answers: separate users give
 * each person their own operating-system user. Turning them on shows the reviewed effects first and
 * applies only on the person's own confirmation; the existing setup, approval and operation owners do
 * the rest, so this view only words their typed results.
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
  const [phase, setPhase] = React.useState<Phase>({ kind: 'offer' });
  const lifetime = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => lifetime.current?.abort(), []);
  const testID = `${idPrefix}machine-share-separate-users`;

  const review = React.useCallback(async () => {
    lifetime.current?.abort();
    const controller = new AbortController();
    lifetime.current = controller;
    setPhase({ kind: 'previewing' });
    const result = await guestExecution
      .previewSeparateUsers(controller.signal)
      .catch(() => null);
    if (controller.signal.aborted) return;
    const preview = result?.ok
      ? MachineAgentIsolationPreviewResultV1Schema.safeParse(result.result)
      : null;
    if (preview?.success && preview.data.kind === 'ready')
      setPhase({ kind: 'review', preview: preview.data });
    else
      setPhase({
        kind: 'settled',
        tone: 'unavailable',
        message: t('machines.sharing.fallback.unavailable', { machine }),
      });
  }, [guestExecution, machine]);

  const apply = React.useCallback(
    async (preview: ReadyPreview) => {
      const controller = lifetime.current ?? new AbortController();
      lifetime.current = controller;
      setPhase({ kind: 'applying', preview });
      const result = await guestExecution
        .applySeparateUsers(preview, controller.signal)
        .catch(() => null);
      if (controller.signal.aborted) return;
      if (!result?.ok) {
        setPhase({
          kind: 'settled',
          tone: 'error',
          message: t('machines.sharing.fallback.failed'),
        });
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
        setPhase({
          kind: 'settled',
          tone: 'error',
          message: t('machines.sharing.fallback.failed'),
        });
        return;
      }
      const value = settled.data;
      // Each typed result keeps its own recovery: a changed plan is reviewed again, never re-applied blind.
      if (value.kind === 'accepted')
        setPhase({
          kind: 'settled',
          tone: 'loading',
          message: t('machines.sharing.fallback.applying', { machine }),
        });
      else if (value.kind === 'unchanged')
        setPhase({
          kind: 'settled',
          tone: 'success',
          message: t('machines.sharing.fallback.alreadyOn'),
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
                : t('machines.sharing.fallback.failed'),
        });
    },
    [guestExecution, machine],
  );

  if (phase.kind === 'offer')
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
              void review();
            }}
          />
        </View>
      </View>
    );
  if (phase.kind === 'previewing')
    return (
      <View style={styles.block} testID={testID}>
        <SurfaceStateCard
          kind="loading"
          size="line"
          testID={`${testID}-previewing`}
          accessibilitySemantics="status"
          title={t('machines.sharing.fallback.previewing', { machine })}
        />
      </View>
    );
  if (phase.kind === 'review' || phase.kind === 'applying') {
    const { plan } = phase.preview;
    const effects = [
      t('machines.sharing.fallback.reviewUsers', { machine }),
      ...(plan.roots.length > 0 || plan.ancestorAcls.length > 0
        ? [t('machines.sharing.fallback.reviewFolders')]
        : []),
      ...(plan.sessionsToReplace > 0
        ? [t('machines.sharing.fallback.reviewSessions', { machine })]
        : []),
      ...(plan.requiresAdmin
        ? [t('machines.sharing.fallback.reviewAdmin', { machine })]
        : []),
    ];
    const applying = phase.kind === 'applying';
    return (
      <View style={styles.block} testID={`${testID}-review`}>
        {effects.map((effect) => (
          <Text key={effect} style={styles.line}>
            {effect}
          </Text>
        ))}
        <RoundButtonSizeScope size="small">
          <View style={styles.actions}>
            <RoundButton
              testID={`${testID}-cancel`}
              display="secondary"
              title={t('common.cancel')}
              disabled={applying}
              onPress={() => setPhase({ kind: 'offer' })}
            />
            <RoundButton
              testID={`${testID}-confirm`}
              title={t('machines.sharing.fallback.confirm')}
              loading={applying}
              disabled={applying}
              onPress={() => {
                void apply(phase.preview);
              }}
            />
          </View>
        </RoundButtonSizeScope>
      </View>
    );
  }
  if (phase.kind === 'approval')
    return (
      <View style={styles.block} testID={testID}>
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
        />
      </View>
    );
  return (
    <View style={styles.block} testID={testID}>
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
                  void review();
                },
              },
            }
          : {})}
      />
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
}));

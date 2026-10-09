import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import {
  ProgressChecklist,
  type ProgressChecklistStep,
} from '@/components/systemTasks/ProgressChecklist';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

/**
 * The composer's one status badge for a machine being created (plan 50s3, lab `m-pick Aprog/Aprogd`) and
 * for a session that runs on someone else's machine (42s2, lab `m-pick S`). Both are ordinary
 * `AgentInputStatusBadge` entries in the composer's own status row; their popovers hold the detail.
 * The label is the latest stage the creation owner observed; nothing here advances a stage or times one.
 */

export type ManagedArchiveChoice = 'keep' | 'stop' | 'delete';

export type ManagedProgressModel = Readonly<{
  machineName: string;
  mark: React.ReactNode;
  /** "Mac desktop · macOS Tahoe · on MacBook Pro". */
  recipe: string;
  /** Observed stages only, in order. */
  stages: readonly Readonly<{
    id: string;
    label: string;
    status: 'done' | 'active' | 'pending' | 'failed';
  }>[];
  failed: boolean;
  /** A native-create/admission failure must not be labelled as an install failure. */
  failureLabel?: string;
  failureTitle?: string;
  /** Cached/unavailable or settled operation observations do not animate as active work. */
  tone?: AgentInputStatusBadge['tone'];
  /** The latest observed stage, worded for the badge ("Installing Happier on mac-vm-2"). */
  label: string;
  /** Informational elapsed time from the owner's observation; never advances anything. */
  elapsed?: string;
  message: string;
  /** D42(4): offered at creation only, Keep by default; Stop/Delete become the session's archive trigger. */
  archiveChoice?: Readonly<{
    value: ManagedArchiveChoice;
    onChange: (next: ManagedArchiveChoice) => void;
    supportedEffects?: readonly ManagedArchiveChoice[];
    availability?: ManagedMachineArchiveChoiceAvailability;
  }>;
  onCancel?: () => void;
  onRetryInstall?: () => void;
  onRetrySetup?: () => void;
  onContinueWithoutSetup?: () => void;
  onDeleteMachine?: () => void;
}>;

export function buildManagedProgressStatusBadge(
  model: ManagedProgressModel,
): AgentInputStatusBadge {
  return {
    key: 'managed-machine-progress',
    label: model.failed
      ? model.failureLabel ?? t('managedMachines.creation.installFailedShort')
      : model.label,
    testID: 'managed-machine-progress-badge',
    accessibilityLabel: model.failed
      ? model.failureTitle ?? t('managedMachines.creation.installFailedTitle', {
          name: model.machineName,
        })
      : model.label,
    accessibilityHint: t('managedMachines.creation.openDetails'),
    tone: model.tone ?? (model.failed ? 'warning' : 'active'),
    icon: (tint) =>
      model.failed ? (
        <Icon name="warning" size={14} color={tint} />
      ) : model.tone && model.tone !== 'active' ? (
        <Icon name="desktop" size={14} color={tint} />
      ) : (
        <ActivitySpinner
          size="small"
          color={tint}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ),
    renderPopover: ({ open, anchorRef, onRequestClose }) => (
      <AgentInputContentPopover
        open={open}
        anchorRef={anchorRef}
        onRequestClose={onRequestClose}
        maxWidthCap={380}
        testID="managed-machine-progress-popover"
        content={() => <ManagedProgressPopoverContent model={model} />}
      />
    ),
  };
}

export const ManagedProgressPopoverContent = React.memo(
  function ManagedProgressPopoverContent(
    props: Readonly<{ model: ManagedProgressModel }>,
  ) {
    const { model } = props;
    const steps = React.useMemo(
      (): ProgressChecklistStep[] =>
        model.stages.map((stage) => ({
          stepId: stage.id,
          title: stage.label,
          status: stage.status,
        })),
      [model.stages],
    );
    return (
      <View style={styles.popover}>
        <View style={styles.head}>
          <View style={styles.mark}>{model.mark}</View>
          <Text style={styles.title} numberOfLines={2}>
            {model.failed
              ? model.failureTitle ?? t('managedMachines.creation.installFailedTitle', {
                  name: model.machineName,
                })
              : t('managedMachines.creation.creating', {
                  name: model.machineName,
                })}
          </Text>
          {model.elapsed ? (
            <Text style={styles.elapsed}>{model.elapsed}</Text>
          ) : null}
        </View>
        <Text style={styles.quiet}>{model.recipe}</Text>
        <ProgressChecklist
          steps={steps}
          testIDPrefix="managed-machine-progress-step"
          showStepMessages={false}
        />
        <Text style={styles.body} accessibilityLiveRegion="polite">
          {model.message}
        </Text>
        {model.archiveChoice && !model.failed ? (
          <View style={styles.archive}>
            <Text style={styles.archiveLabel}>
              {t('managedRetention.whenSessionArchived')}
            </Text>
            <SegmentedTabBar<ManagedArchiveChoice>
              role="radiogroup"
              accessibilityLabel={t('managedRetention.whenSessionArchived')}
              compact
              testIDPrefix="managed-machine-progress-archive"
              activeTabId={model.archiveChoice.value}
              onSelectTab={model.archiveChoice.onChange}
              tabs={[
                { id: 'keep', label: t('managedRetention.scopeKeep') },
                { id: 'stop', label: t('managedRetention.scopeStop'),
                  disabled: model.archiveChoice.supportedEffects?.includes('stop') === false,
                  unavailableReason: archiveUnavailableReason(model.archiveChoice, 'stop') },
                { id: 'delete', label: t('managedRetention.scopeDelete'),
                  disabled: model.archiveChoice.supportedEffects?.includes('delete') === false,
                  unavailableReason: archiveUnavailableReason(model.archiveChoice, 'delete') },
              ]}
            />
          </View>
        ) : null}
        {/* The irreversible delete stands apart at the leading edge; one bordered next step closes the row. */}
        <SectionButtonRow
          trailing={
            <>
              {model.failed && model.onContinueWithoutSetup ? (
                <RoundButton
                  testID="managed-machine-progress-skip-setup"
                  size="small"
                  display="inverted"
                  title={t('managedMachines.creation.skipSetup')}
                  onPress={model.onContinueWithoutSetup}
                />
              ) : null}
              {model.failed && model.onRetryInstall ? (
                <RoundButton
                  testID="managed-machine-progress-retry"
                  size="small"
                  display={model.onRetrySetup ? 'inverted' : 'secondary'}
                  title={t('managedMachines.creation.retryInstall')}
                  onPress={model.onRetryInstall}
                />
              ) : null}
              {model.failed && model.onRetrySetup ? (
                <RoundButton
                  testID="managed-machine-progress-retry-setup"
                  size="small"
                  display="secondary"
                  title={t('managedMachines.creation.retrySetup')}
                  onPress={model.onRetrySetup}
                />
              ) : null}
              {model.onCancel ? (
                <RoundButton
                  testID="managed-machine-progress-cancel"
                  size="small"
                  display="inverted"
                  title={t('common.cancel')}
                  onPress={model.onCancel}
                />
              ) : null}
            </>
          }
        >
          {model.failed && model.onDeleteMachine ? (
            <RoundButton
              testID="managed-machine-progress-delete"
              size="small"
              display="destructive"
              title={t('managedMachines.actions.deleteMachine')}
              onPress={model.onDeleteMachine}
            />
          ) : null}
        </SectionButtonRow>
      </View>
    );
  },
);

/** Why a disabled archive effect cannot be chosen: the provider lacks it, or the controller cannot run the rule. */
function archiveUnavailableReason(
  choice: NonNullable<ManagedProgressModel['archiveChoice']>,
  effect: 'stop' | 'delete',
): string | undefined {
  if (choice.supportedEffects?.includes(effect) !== false) return undefined;
  if (choice.availability?.nativeUnsupportedEffects.includes(effect))
    return effect === 'stop'
      ? t('managedRetention.scopeStopUnsupported')
      : t('managedRetention.scopeDeleteUnsupported');
  return t('managedRetention.scopeControllerUnavailable', {
    controller: choice.availability?.controllerName ?? t('managedRetention.scopeControllerFallback'),
  });
}

export type RequesterDisclosureModel = Readonly<{
  owner: string;
  machine: string;
  /** `scoped` only when the scoped sign-in route was proven; `full` is the documented fallback. */
  signIn: 'scoped' | 'full';
  onLearnMore?: () => void;
}>;

/** "Runs on Ben's build-01": whose machine it is, how the sign-in lands, who can see the files. */
export function buildRequesterDisclosureStatusBadge(
  model: RequesterDisclosureModel,
): AgentInputStatusBadge {
  const label = t('machineRequester.runsOn', {
    owner: model.owner,
    machine: model.machine,
  });
  return {
    key: 'machine-requester-disclosure',
    label,
    labelNumberOfLines: 0,
    testID: 'machine-requester-disclosure-badge',
    accessibilityLabel: label,
    tone: 'neutral',
    icon: (tint) => <Icon name="users" size={14} color={tint} />,
    renderPopover: ({ open, anchorRef, onRequestClose }) => (
      <AgentInputContentPopover
        open={open}
        anchorRef={anchorRef}
        onRequestClose={onRequestClose}
        maxWidthCap={360}
        testID="machine-requester-disclosure-popover"
        content={() => <RequesterDisclosureContent model={model} />}
      />
    ),
  };
}

function RequesterDisclosureContent(
  props: Readonly<{ model: RequesterDisclosureModel }>,
) {
  const { theme } = useUnistyles();
  const { model } = props;
  return (
    <View style={styles.popover}>
      <View style={styles.head}>
        <Icon
          name="hard-drives"
          size={16}
          color={theme.colors.text.secondary}
        />
        <Text style={styles.title}>
          {t('machineRequester.runsOn', {
            owner: model.owner,
            machine: model.machine,
          })}
        </Text>
      </View>
      <Text style={styles.body}>
        {model.signIn === 'scoped'
          ? t('machineRequester.scopedSignIn', { machine: model.machine })
          : t('machineRequester.fullSignIn', { machine: model.machine })}{' '}
        {t('machineRequester.osVisibility', {
          owner: model.owner,
          machine: model.machine,
        })}
      </Text>
      {model.onLearnMore ? (
        <Text
          accessibilityRole="link"
          style={styles.link}
          onPress={model.onLearnMore}
        >
          {t('machineRequester.howShared')}
        </Text>
      ) : null}
    </View>
  );
}

const rowDescription = happierPageTextMetrics('rowDescription');

const styles = StyleSheet.create((theme) => ({
  popover: {
    padding: 14,
    gap: 8,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mark: {
    width: 16,
    alignItems: 'center',
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    flex: 1,
  },
  elapsed: {
    ...Typography.default(),
    ...Typography.tabular(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  archiveLabel: {
    ...Typography.default('medium'),
    ...rowDescription,
    color: theme.colors.text.primary,
  },
  quiet: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  body: {
    ...Typography.default(),
    ...rowDescription,
    color: theme.colors.text.secondary,
  },
  link: {
    ...Typography.default('medium'),
    ...rowDescription,
    color: theme.colors.text.link,
  },
  archive: {
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
}));

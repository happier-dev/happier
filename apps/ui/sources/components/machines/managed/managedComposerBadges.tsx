import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import {
  SetupSteps,
  setupStepTestID,
  type SetupStep,
  type SetupStepState,
} from '@/components/ui/setupBlocks/SetupSteps';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';
import { RequesterDisclosureContent, type RequesterDisclosureModel } from './RequesterDisclosure';

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
  launch: string;
  /** Who does the work, when it is this device ("From this phone"): joins the launch line. */
  origin?: string;
  /** "Keep Happier open until vercel-1 joins.": only while this device is the one doing the work. */
  hold?: Readonly<{ text: string; icon: 'device-mobile' | 'laptop' | 'globe' }>;
  /**
   * A creation nothing is running for any more, read from the resource's recorded facts (58b L4 "Setup
   * interrupted"): it names the state, leads its message with what is missing, and offers the same-resource ways forward.
   */
  recovery?: Readonly<{
    title: string;
    lead: string;
    onContinue?: () => void;
    onInspect?: () => void;
  }>;
  /** Observed stages only, in order. */
  stages: readonly Readonly<{
    id: string;
    label: string;
    state: Extract<SetupStepState, 'done' | 'running' | 'upcoming' | 'failed'>;
    /** A recorded fact at the step's end ("Not joined"). */
    meta?: string;
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
    /** Whose end the rule waits for: a Session's archive (default) or a task's finish (D23). */
    scope?: 'session' | 'task';
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
    label: model.recovery?.title ?? (model.failed
      ? model.failureLabel ?? t('managedMachines.creation.installFailedShort')
      : model.label),
    testID: 'managed-machine-progress-badge',
    accessibilityLabel: model.recovery ? model.recovery.title : model.failed
      ? model.failureTitle ?? t('managedMachines.creation.installFailedTitle', {
          name: model.machineName,
        })
      : model.label,
    accessibilityHint: t('managedMachines.creation.openDetails'),
    // Creation in progress needs nothing from the user: the neutral badge, its spinner the only motion
    // (lab `m-pick-Aprog`). Only an observed failure speaks; a settled or cached observation keeps its tone.
    tone: model.failed || model.recovery
      ? 'warning'
      : isManagedProgressWorking(model) ? 'neutral' : model.tone,
    icon: (tint) =>
      model.failed || model.recovery ? (
        <Icon name="warning" size={14} color={tint} />
      ) : !isManagedProgressWorking(model) ? (
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
        // A phone opens the same stages as a bottom sheet, led by the content's own title (lab af-create Op).
        phonePresentation="sheet"
        testID="managed-machine-progress-popover"
        content={() => <ManagedProgressPopoverContent model={model} />}
      />
    ),
  };
}

/** Creation the owner still observes as live work (no tone, or `active`); anything else has settled. */
function isManagedProgressWorking(model: ManagedProgressModel): boolean {
  return model.tone === undefined || model.tone === 'active';
}

export const ManagedProgressPopoverContent = React.memo(
  function ManagedProgressPopoverContent(
    props: Readonly<{ model: ManagedProgressModel }>,
  ) {
    const { model } = props;
    const { theme } = useUnistyles();
    const steps = React.useMemo(
      (): SetupStep[] =>
        model.stages.map((stage) => ({
          key: stage.id,
          title: stage.label,
          state: stage.state,
          ...(stage.meta ? { meta: stage.meta } : {}),
          testID: setupStepTestID('managed-machine-progress-step', stage.id, stage.state),
        })),
      [model.stages],
    );
    const deleteMachine = model.failed && model.onDeleteMachine ? (
      <RoundButton
        testID="managed-machine-progress-delete"
        size="small"
        display="destructive"
        title={t('managedMachines.actions.deleteMachine')}
        onPress={model.onDeleteMachine}
      />
    ) : null;
    const deleteInOwnRow = deleteMachine !== null && Boolean(model.onContinueWithoutSetup)
      && Boolean(model.onRetrySetup || model.onRetryInstall);
    return (
      <View style={styles.popover}>
        <View style={styles.head}>
          {model.mark ? <View style={styles.mark}>{model.mark}</View> : null}
          <Text style={styles.title} numberOfLines={2}>
            {model.recovery ? model.recovery.title : model.failed
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
        {model.launch || model.origin ? (
          <Text style={styles.quiet}>{[model.launch, model.origin].filter(Boolean).join(' · ')}</Text>
        ) : null}
        <SetupSteps
          testID="managed-machine-progress-steps"
          variant="compact"
          steps={steps}
        />
        <Text style={styles.body} accessibilityLiveRegion="polite">
          {model.recovery ? <Text style={styles.bodyLead}>{model.recovery.lead} </Text> : null}
          {model.message}
        </Text>
        {model.hold ? (
          <View style={styles.hold} testID="managed-machine-progress-hold">
            <Icon name={model.hold.icon} size={14} color={theme.colors.text.secondary} />
            <Text style={styles.holdText}>{model.hold.text}</Text>
          </View>
        ) : null}
        {model.archiveChoice && !model.failed && !model.recovery ? (
          <View style={styles.archive}>
            <Text style={styles.archiveLabel}>
              {archiveScopeLabel(model.archiveChoice)}
            </Text>
            {/* Three short words: the control is as wide as its words, not the popover. */}
            <View style={styles.archiveChoice}>
            <SegmentedTabBar<ManagedArchiveChoice>
              role="radiogroup"
              accessibilityLabel={archiveScopeLabel(model.archiveChoice)}
              compact
              segmentSizing="content"
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
          </View>
        ) : null}
        {/* The ways forward close the popover at its trailing edge, quiet first and the one bordered next step
            last (lab m-life 1). */}
        <SectionButtonRow
          trailing={
            <>
              {model.recovery?.onInspect ? (
                <RoundButton
                  testID="managed-machine-progress-inspect"
                  size="small"
                  display="inverted"
                  title={t('managedMachines.creation.inspect')}
                  onPress={model.recovery.onInspect}
                />
              ) : null}
              {model.recovery?.onContinue ? (
                <RoundButton
                  testID="managed-machine-progress-continue"
                  size="small"
                  display="secondary"
                  title={t('managedMachines.creation.continueSetup')}
                  onPress={model.recovery.onContinue}
                />
              ) : null}
              {deleteInOwnRow ? null : deleteMachine}
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
              {model.onCancel && !model.recovery ? (
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
          {null}
        </SectionButtonRow>
        {/* Three ways forward do not fit one line: the irreversible one takes the last line on its own. */}
        {deleteInOwnRow ? <SectionButtonRow trailing={deleteMachine}>{null}</SectionButtonRow> : null}
      </View>
    );
  },
);

/** The rule's trigger in words, for the visible label and the control's accessibility label alike. */
function archiveScopeLabel(choice: NonNullable<ManagedProgressModel['archiveChoice']>): string {
  return choice.scope === 'task'
    ? t('managedRetention.whenTaskFinishes')
    : t('managedRetention.whenSessionArchived');
}

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

const rowDescription = happierPageTextMetrics('rowDescription');

const styles = StyleSheet.create((theme) => ({
  popover: {
    padding: 14,
    gap: theme.space.s8,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
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
  bodyLead: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  hold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  holdText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  // Three one-word segments: as wide as their words, at the popover's leading edge (lab m-pick Aprogd).
  archiveChoice: {
    alignSelf: 'flex-start',
  },
  archive: {
    gap: theme.space.s6,
    paddingTop: theme.space.s8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
}));

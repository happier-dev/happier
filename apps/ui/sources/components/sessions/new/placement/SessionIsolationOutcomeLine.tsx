import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineIsolationGetResultV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import type { SessionProjectFilesSourceV1, SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';

import { useMachinePreset } from '@/components/settings/machines/managed/useMachinePresets';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { proposeMachineIsolationOutcome } from '@/sync/domains/machines/machineIsolationPolicy';
import { t } from '@/text';
import type { MachineManagedPresence } from '@/utils/sessions/machinePresenceLine';
import { ProjectFilesOutcomeChoice } from './ProjectFilesOutcomeChoice';

export type SessionIsolationOutcome = ReturnType<
  typeof proposeMachineIsolationOutcome
>;

/**
 * Whether the outcome line says the chosen Machine is offline or absent. The
 * composer's status line then says nothing more about it: one cause, one line.
 */
export function sessionIsolationOutcomeSaysMachineStatus(input: Readonly<{
  machineName: string | null;
  snapshot: MachineIsolationGetResultV1;
  offline?: boolean;
  managedPresence?: MachineManagedPresence | null;
}>): boolean {
  return Boolean(input.machineName) && (input.managedPresence?.offline?.state === 'resource_absent'
    || input.offline === true && input.snapshot.status === 'ready');
}

/**
 * What Send will do on the chosen Machine (lab machine-sandboxes-1115 scene 2 and J6): one quiet line from the
 * isolation owner's proposed outcome, shared by New Session and the workflow editor so both say it the same way.
 * "Run directly this time" appears only when the host passes `onOverrideChange` (an interactive Manage start);
 * the receiving daemon still decides, so this line never claims more than the stored policy proposes.
 */
export function SessionIsolationOutcomeLine(
  props: Readonly<{
    serverId: string | null;
    machineName: string | null;
    snapshot: MachineIsolationGetResultV1;
    outcome: SessionIsolationOutcome | undefined;
    override?: 'directly';
    /** The chosen Machine is offline: the draft waits, and the line says what happens once it is back. */
    offline?: boolean;
    /** The same native lifecycle presentation used by the Machine picker; absence overrides connectivity. */
    managedPresence?: MachineManagedPresence | null;
    onOverrideChange?: (value: 'directly' | undefined) => void;
    /**
     * The per-Session Project files choice (lab F2): a fresh sandbox's line then leads with what happens to the
     * folder, and that verb phrase opens the choice. Hosts that start no Session omit it.
     */
    /**
     * An explicit cloud preset the host holds (New Session's or a workflow's Machine picker): the work runs on a new
     * machine from it, not on the chosen Machine, so the line names the preset instead of the Machine's policy.
     */
    placementPreset?: Readonly<{ presetId: string }> | null;
    projectFiles?: Readonly<{
      /** The folder whose files go in; absent before one is chosen. */
      source: SessionProjectFilesSourceV1 | undefined;
      override: SessionProjectFilesV1 | undefined;
      onChange: (value: SessionProjectFilesV1 | undefined) => void;
    }>;
    testID?: string;
  }>,
): React.ReactElement | null {
  const { snapshot, outcome, machineName } = props;
  const testID = props.testID ?? 'session-isolation-outcome';
  const presetId = props.placementPreset?.presetId
    ?? (outcome?.status === 'proposed' && outcome.choice.kind === 'sandbox'
      ? outcome.configuredSandbox?.presetId
      : undefined);
  const presetServerId = presetId ? props.serverId ?? '' : '';
  const { state: { value: preset } } = useMachinePreset(presetServerId, presetId ?? '');
  const sandboxRow = (projectFiles: typeof props.projectFiles, text: (syncsBothWays: boolean) => string,
    link: Readonly<{ label: string; onPress: () => void }> | null) => {
    const effective = projectFiles ? projectFiles.override ?? preset?.projectFiles : undefined;
    return (
      <OutcomeRow
        testID={testID}
        lead={projectFiles ? (
          <ProjectFilesOutcomeChoice
            testID={`${testID}.project-files`}
            source={projectFiles.source}
            presetDefault={preset?.projectFiles}
            override={projectFiles.override}
            onChange={projectFiles.onChange}
            preset={preset && props.serverId ? { serverId: props.serverId, id: preset.id, name: preset.name } : null}
          />
        ) : undefined}
        // The sandbox's own mark, as the Isolation page draws it; a preset not read yet takes the generic one.
        mark={preset && props.serverId ? <ManagedPresetMark serverId={props.serverId} preset={preset} size={OUTCOME_MARK_SIZE} /> : undefined}
        glyph="cube"
        text={text(effective?.kind === 'sync' && effective.mode === 'keep_both_in_sync')}
        link={link}
      />
    );
  };
  const name = preset?.name ?? t('machineDetailPage.isolation.summary.unnamed');
  // An explicit cloud preset: the folder goes to a new machine from it (lab F2 "cloud"); the Machine's policy is moot.
  if (props.placementPreset) {
    if (!props.projectFiles) return null;
    return sandboxRow(props.projectFiles, (both) => t(both ? 'machineDetailPage.projectFiles.withNew'
      : 'machineDetailPage.projectFiles.intoNew', { name }), null);
  }
  if (!machineName) return null;
  if (props.managedPresence?.offline?.state === 'resource_absent')
    return <OutcomeRow testID={testID} glyph="cloud-slash" text={props.managedPresence.offline.word} link={null} />;
  if (snapshot.status !== 'ready') return null;
  const machine = machineName;
  if (sessionIsolationOutcomeSaysMachineStatus(props))
    return (
      <OutcomeRow
        testID={testID}
        glyph="cloud-slash"
        text={t('machineDetailPage.isolation.outcome.offline', { machine })}
        link={null}
      />
    );
  if (props.override === 'directly') {
    return (
      <OutcomeRow
        testID={testID}
        glyph="desktop"
        text={t('machineDetailPage.isolation.outcome.directlyOnce', {
          machine,
        })}
        link={
          props.onOverrideChange
            ? {
                label: t('machineDetailPage.isolation.outcome.useSandbox'),
                onPress: () => props.onOverrideChange?.(undefined),
              }
            : null
        }
      />
    );
  }
  if (!outcome)
    return (
      <OutcomeRow
        testID={testID}
        glyph="desktop"
        text={t('machineDetailPage.isolation.outcome.directly', { machine })}
        link={null}
      />
    );
  if (outcome.status !== 'proposed')
    return (
      <OutcomeRow
        testID={testID}
        glyph="warning"
        text={t('machineDetailPage.isolation.outcome.unavailable', { machine })}
        link={null}
        warning
      />
    );
  if (outcome.choice.kind === 'directly')
    return (
      <OutcomeRow
        testID={testID}
        glyph="desktop"
        text={t('machineDetailPage.isolation.outcome.directly', { machine })}
        link={null}
      />
    );
  // A sandbox gets the folder's files, fresh or kept: the line says how first, and that phrase changes it for this
  // Session. Without a Project files host the line only says where it runs.
  const fresh = outcome.choice.lifecycle === 'fresh';
  return sandboxRow(props.projectFiles, (both) => props.projectFiles
    ? t(fresh ? (both ? 'machineDetailPage.projectFiles.withFresh' : 'machineDetailPage.projectFiles.intoFresh')
      : (both ? 'machineDetailPage.projectFiles.withKept' : 'machineDetailPage.projectFiles.intoKept'), { name, machine })
    : t(fresh ? 'machineDetailPage.isolation.outcome.fresh' : 'machineDetailPage.isolation.outcome.kept', { name, machine }),
  props.onOverrideChange
    ? {
        label: t('machineDetailPage.isolation.outcome.runDirectlyOnce'),
        onPress: () => props.onOverrideChange?.('directly'),
      }
    : null);
}

/** The meta line's mark: one step under the row mark, the size of the line's own glyphs. */
const OUTCOME_MARK_SIZE = 14;

/**
 * The composer's outcome line anatomy (lab sbx-outcome): one quiet meta sentence under the composer saying what
 * Send will do, with its mark and an optional link. Shared by the isolation outcome and bulk compose.
 */
export function OutcomeRow(
  props: Readonly<{
    testID: string;
    text: React.ReactNode;
    /** A control that reads as the sentence's first words (the Project files verb phrase). */
    lead?: React.ReactNode;
    glyph: IconName;
    mark?: React.ReactNode;
    warning?: boolean;
    link: Readonly<{ label: string; onPress: () => void }> | null;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View
      testID={props.testID}
      style={styles.row}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.mark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {props.mark ?? <Icon name={props.glyph} size={OUTCOME_MARK_SIZE}
          color={props.warning ? theme.colors.state.warning.foreground : theme.colors.text.secondary} />}
      </View>
      {/* The mark keeps its column; the sentence wraps in its own column and the link keeps the line's end (lab
          sbx-outcome: sentence left, action right, on a phone too), so a narrow field (a workflow's Machine) never
          drops the sentence under a lone mark or the action onto a line of its own. */}
      <View style={styles.body}>
        <View style={styles.sentence}>
          {props.lead}
          {/* After a verb phrase the sentence keeps one line (lab sbx-outcome phone). Alone it wraps whole: a status
              sentence (an offline Machine's) is never cut mid-sentence (WF-ACCEPT-1118B item 7). */}
          <Text style={props.warning ? styles.warning : styles.text} {...(props.lead ? { numberOfLines: 1 } : {})}
            {...(typeof props.text === 'string' ? { accessibilityLabel: props.text } : {})}>
            {props.text}
          </Text>
        </View>
        {props.link ? (
          <View style={styles.link}>
            <TextLinkButton
              testID={`${props.testID}.link`}
              label={props.link.label}
              onPress={props.link.onPress}
              tone="quiet"
              size="meta"
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    columnGap: theme.space.s8,
    marginTop: theme.space.s8,
  },
  body: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    columnGap: theme.space.s8,
  },
  // The sentence takes what the link leaves and wraps; the link is one line (the shared link never wraps), so it
  // keeps its words whole at the line's end.
  sentence: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s2,
  },
  link: { flexShrink: 0 },
  mark: { height: Typography.variant('meta').lineHeight, justifyContent: 'center' },
  text: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 },
  warning: {
    ...Typography.variant('meta'),
    color: theme.colors.state.warning.textForeground,
  },
}));

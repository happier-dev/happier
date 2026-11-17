import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineIsolationGetResultV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';

import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { proposeMachineIsolationOutcome } from '@/sync/domains/machines/machineIsolationPolicy';
import { isOpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { t } from '@/text';

const NO_SERVERS: readonly string[] = Object.freeze([]);

export type SessionIsolationOutcome = ReturnType<
  typeof proposeMachineIsolationOutcome
>;

/**
 * Whether the outcome line says the chosen Machine is offline (with what happens to the draft, lab case 9). The
 * composer's status line then says nothing more about it: one cause, one line.
 */
export function sessionIsolationOutcomeSaysOffline(input: Readonly<{
  machineName: string | null;
  snapshot: MachineIsolationGetResultV1;
  offline?: boolean;
}>): boolean {
  return input.offline === true && Boolean(input.machineName) && input.snapshot.status === 'ready';
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
    onOverrideChange?: (value: 'directly' | undefined) => void;
    testID?: string;
  }>,
): React.ReactElement | null {
  const { snapshot, outcome, machineName } = props;
  const testID = props.testID ?? 'session-isolation-outcome';
  const presetId =
    outcome?.status === 'proposed' && outcome.choice.kind === 'sandbox'
      ? outcome.configuredSandbox?.presetId
      : undefined;
  const preset = usePreset(props.serverId, presetId);
  if (!machineName || snapshot.status !== 'ready') return null;
  const machine = machineName;
  if (sessionIsolationOutcomeSaysOffline(props))
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
  const name = preset?.name ?? t('machineDetailPage.isolation.summary.unnamed');
  const text =
    outcome.choice.lifecycle === 'fresh'
      ? t('machineDetailPage.isolation.outcome.fresh', { name, machine })
      : t('machineDetailPage.isolation.outcome.kept', { name, machine });
  return (
    <OutcomeRow
      testID={testID}
      // The sandbox's own mark, as the Isolation page draws it; a preset not read yet takes the generic one.
      mark={preset && props.serverId ? <ManagedPresetMark serverId={props.serverId} preset={preset} size={OUTCOME_MARK_SIZE} /> : undefined}
      glyph="cube"
      text={text}
      link={
        props.onOverrideChange
          ? {
              label: t('machineDetailPage.isolation.outcome.runDirectlyOnce'),
              onPress: () => props.onOverrideChange?.('directly'),
            }
          : null
      }
    />
  );
}

/** The chosen preset, read from the Account's preset resource only while a sandbox is proposed. */
function usePreset(
  serverId: string | null,
  presetId: string | undefined,
) {
  const serverIds = React.useMemo(
    () => (serverId && presetId ? [serverId] : NO_SERVERS),
    [serverId, presetId],
  );
  const presets = useMachinePresets(serverIds);
  const preset =
    serverId && presetId
      ? presets.presetsByServerId[serverId]?.find(
          (entry) => entry.id === presetId,
        )
      : undefined;
  return preset && isOpenedManagedMachinePresetV1(preset) ? preset : null;
}

/** The meta line's mark: one step under the row mark, the size of the line's own glyphs. */
const OUTCOME_MARK_SIZE = 14;

function OutcomeRow(
  props: Readonly<{
    testID: string;
    text: string;
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
      {/* The mark keeps its column; the sentence and its link wrap beside it, so a narrow field (a workflow's
          Machine) never drops the sentence under a lone mark. */}
      <View style={styles.body}>
        <Text style={props.warning ? styles.warning : styles.text}>
          {props.text}
        </Text>
        {props.link ? (
          <TextLinkButton
            testID={`${props.testID}.link`}
            label={props.link.label}
            onPress={props.link.onPress}
            tone="quiet"
            size="meta"
          />
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
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s2,
  },
  mark: { height: Typography.variant('meta').lineHeight, justifyContent: 'center' },
  text: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 },
  warning: {
    ...Typography.variant('meta'),
    color: theme.colors.state.warning.foreground,
  },
}));

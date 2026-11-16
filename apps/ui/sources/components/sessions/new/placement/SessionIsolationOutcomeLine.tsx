import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MachineIsolationGetResultV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';

import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
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
  const presetName = usePresetName(props.serverId, presetId);
  if (!machineName || snapshot.status !== 'ready') return null;
  const machine = machineName;
  if (props.override === 'directly') {
    return (
      <OutcomeRow
        testID={testID}
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
        text={t('machineDetailPage.isolation.outcome.directly', { machine })}
        link={null}
      />
    );
  if (outcome.status !== 'proposed')
    return (
      <OutcomeRow
        testID={testID}
        text={t('machineDetailPage.isolation.outcome.unavailable', { machine })}
        link={null}
        warning
      />
    );
  if (outcome.choice.kind === 'directly')
    return (
      <OutcomeRow
        testID={testID}
        text={t('machineDetailPage.isolation.outcome.directly', { machine })}
        link={null}
      />
    );
  const name = presetName ?? t('machineDetailPage.isolation.summary.unnamed');
  const text =
    outcome.choice.lifecycle === 'fresh'
      ? t('machineDetailPage.isolation.outcome.fresh', { name, machine })
      : t('machineDetailPage.isolation.outcome.kept', { name, machine });
  return (
    <OutcomeRow
      testID={testID}
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

/** The chosen preset's own name, read from the Account's preset resource only while a sandbox is proposed. */
function usePresetName(
  serverId: string | null,
  presetId: string | undefined,
): string | null {
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
  return preset && isOpenedManagedMachinePresetV1(preset) ? preset.name : null;
}

function OutcomeRow(
  props: Readonly<{
    testID: string;
    text: string;
    warning?: boolean;
    link: Readonly<{ label: string; onPress: () => void }> | null;
  }>,
) {
  return (
    <View
      testID={props.testID}
      style={styles.row}
      accessibilityLiveRegion="polite"
    >
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
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: theme.space.s8,
    rowGap: theme.space.s2,
    marginTop: theme.space.s8,
  },
  text: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  warning: {
    ...Typography.variant('meta'),
    color: theme.colors.state.warning.foreground,
  },
}));

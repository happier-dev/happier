import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';

import { t } from '@/text';

import { isUnreachableCause, type FoundMachineBody } from './foundMachineModel';

/** The words a Found page uses for one machine's states; each kind of capability names what it looks for. */
export type FoundMachineGroupCopy = Readonly<{
  looking: string;
  nothingHere: string;
  scanFailed: string;
  tryAgain: string;
  olderMachine: string;
  lastKnown: (time: string) => string;
  /** Under an offline machine's retained rows: what brings Add back. */
  offlineBring: string;
}>;

/**
 * One machine's section on a "Found on your machines" page (Skills, MCP servers): the machine as the section
 * title with its count, an offline machine's freshness chip over its retained rows, and the one line for a
 * machine being read, that could not be read (with Try again), or where nothing was found. A machine's failure
 * stays in its own section. Rows and per-section actions come from the page.
 */
export const FoundMachineGroup = React.memo(function FoundMachineGroup(props: Readonly<{
  machine: ReachMachine;
  body: FoundMachineBody<unknown>;
  /** The latest read failed; shown even over last-known rows while the machine is online. */
  failed: boolean;
  /** The typed cause the failed read returned: said in plain words when it is a known kind, always kept under Details. */
  cause?: string | null;
  /** Rows are retained from an earlier read. */
  hasLastKnown: boolean;
  count: number | null;
  copy: FoundMachineGroupCopy;
  onTryAgain: () => void;
  action?: React.ReactNode;
  testIDPrefix: string;
  children?: React.ReactNode;
}>) {
  const { machine, body, copy, testIDPrefix } = props;
  const { theme } = useUnistyles();
  const id = machine.machineId;
  const titleAccessory = (
    <View style={styles.titleAccessory}>
      {body.kind === 'rows' && props.count !== null ? (
        <Text variant="meta" style={styles.count}>
          {String(props.count)}
        </Text>
      ) : null}
      {machine.offline ? (
        <CapabilityStatusChip
          testID={`${testIDPrefix}.offline.${id}`}
          status={{
            kind: 'offline',
            ...(props.hasLastKnown ? { detail: copy.lastKnown(formatLastSeen(machine.lastSeenAt ?? 0)) } : {}),
          }}
        />
      ) : null}
    </View>
  );
  return (
    <ItemGroup
      testID={`${testIDPrefix}.machine.${id}`}
      title={machine.name ?? id}
      titleLeading={<Icon name="desktop" size={18} color={theme.colors.text.secondary} />}
      titleAccessory={titleAccessory}
      {...(props.action ? { action: props.action } : {})}
      {...(machine.offline && props.hasLastKnown ? { description: copy.offlineBring } : {})}
    >
      {body.kind === 'looking' ? (
        <SurfaceStateCard testID={`${testIDPrefix}.looking.${id}`} size="line" kind="loading" title={copy.looking} />
      ) : null}
      {body.kind === 'older_machine' ? (
        <SurfaceStateCard testID={`${testIDPrefix}.older.${id}`} size="line" kind="empty" title={copy.olderMachine} />
      ) : null}
      {machine.online === true && (body.kind === 'failed' || (props.failed && body.kind !== 'older_machine')) ? (
        <SurfaceStateCard
          testID={`${testIDPrefix}.failed.${id}`}
          size="line"
          kind="error"
          title={copy.scanFailed}
          {...(isUnreachableCause(props.cause) ? { reason: t('capabilities.detail.scanUnreachable') } : {})}
          diagnosticCode={props.cause ?? null}
          action={{ label: copy.tryAgain, onPress: props.onTryAgain }}
        />
      ) : null}
      {body.kind === 'empty' ? (
        <SurfaceStateCard testID={`${testIDPrefix}.empty.${id}`} size="line" kind="empty" title={copy.nothingHere} />
      ) : null}
      {props.children}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  titleAccessory: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 1 },
  count: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
}));

/** One quiet line of the closing group: what is true of the machines that have no section of their own. */
export type FoundQuietLine = Readonly<{
  id: string;
  kind: 'loading' | 'empty' | 'unavailable';
  title: string;
}>;

/**
 * After the machine sections: the machines with nothing to show (being read, read with nothing found, offline and
 * never seen) named once each, as a count (one cause, one line), together in one section so it keeps the page's
 * section rhythm instead of becoming a wall of cards that each say "nothing here".
 */
export function FoundQuietMachines(props: Readonly<{ lines: readonly FoundQuietLine[]; testID: string }>) {
  if (props.lines.length === 0) return null;
  return (
    <ItemGroup testID={`${props.testID}.group`}>
      {props.lines.map((line) => (
        <SurfaceStateCard
          key={line.id}
          testID={props.lines.length === 1 ? props.testID : `${props.testID}.${line.id}`}
          size="line"
          kind={line.kind}
          title={line.title}
        />
      ))}
    </ItemGroup>
  );
}

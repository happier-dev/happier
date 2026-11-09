import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { StyleSheet } from 'react-native-unistyles';

import { AgentNameRun } from '@/components/capabilities/identity/AgentNameRun';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * When an offline machine was last known, in the short form the legend's narrow line can hold whole: the clock time
 * today, the date otherwise ("Offline · last known 09:12").
 */
function formatLastKnown(ms: number, now: number = Date.now()): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(ms);
}

export type CapabilityReachLegendRow = Readonly<{
  machineId: string;
  name: string;
  offline: boolean;
  lastSeenAt: number | null;
  /** The Agents on it that can take these items (the words of "reach"). */
  agentIds: readonly string[];
  /** It has Agents, but none of them can take this kind of item (said in words, never as "no agents"). */
  noSkillAgents?: boolean;
  /** How many items reach it; last known for an offline machine. */
  count: number | null;
  inventoryUnknown?: boolean;
}>;

/**
 * The reach map's legend and its accessible content (P5 R4/C23): one row per Account machine with its
 * device glyph, name, who gets something there and how many. Offline machines say so, dated. A row
 * press filters the list to that machine.
 */
export const CapabilityReachLegend = React.memo(function CapabilityReachLegend(
  props: Readonly<{
    rows: readonly CapabilityReachLegendRow[];
    /** While one item is previewed: the Agents that get it on each machine (the legend reads "who gets this one"). */
    preview?: Readonly<Record<string, readonly string[]>> | null;
    onMachinePress?: (machineId: string) => void;
    /** Machines past the map's room: one quiet closing line, never a row per machine. */
    more?: number;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <ItemGroup header="none" surface="none" testID={props.testID}>
      {props.rows.map((row) => {
        const previewAgents = props.preview
          ? (props.preview[row.machineId] ?? [])
          : null;
        const agents = previewAgents ?? row.agentIds;
        const subtitle = row.offline ? (
          row.lastSeenAt ? (
            t('capabilities.skills.home.offlineLastKnown', {
              time: formatLastKnown(row.lastSeenAt),
            })
          ) : (
            t('capabilities.skills.home.offline')
          )
        ) : agents.length > 0 ? (
          <AgentNameRun agentIds={agents} machineId={row.machineId} tone="primary" form="legend" />
        ) : row.inventoryUnknown ? (
          '—'
        ) : previewAgents ? (
          '—'
        ) : row.noSkillAgents ? (
          t('capabilities.skills.home.noSkillAgents')
        ) : (
          t('capabilities.skills.home.noAgents')
        );
        return (
          <Item
            rowRole="catalogRow"
            key={row.machineId}
            testID={`${props.testID}.machine.${row.machineId}`}
            title={row.name}
            titleStyle={row.offline ? styles.offline : undefined}
            subtitle={subtitle}
            icon={
              <Icon
                name="desktop"
                size={20}
                color={theme.colors.text.secondary}
              />
            }
            titleMeta={
              previewAgents ? null : (
                <Text
                  variant="label"
                  style={[styles.count, row.offline ? styles.offline : null]}
                >
                  {row.count === null ? '—' : String(row.count)}
                </Text>
              )
            }
            showChevron={false}
            {...(props.onMachinePress
              ? { onPress: () => props.onMachinePress?.(row.machineId) }
              : {})}
          />
        );
      })}
      {props.more ? (
        <Item
          rowRole="item"
          testID={`${props.testID}.more`}
          title={t('capabilities.skills.home.moreMachines', { count: props.more })}
          titleStyle={styles.offline}
          showChevron={false}
        />
      ) : null}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  count: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
  offline: { color: theme.colors.text.secondary },
}));

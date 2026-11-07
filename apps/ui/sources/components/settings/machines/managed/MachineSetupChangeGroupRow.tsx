import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';
import type { MachineSetupChangeGroup, MachineSetupChangeKind } from './machineSetupReviewChanges';

const CHANGE_ICONS: Record<MachineSetupChangeKind, IconName> = {
  packages: 'cube',
  files: 'file',
  users: 'users',
  ports: 'globe',
  services: 'gear',
  commands: 'terminal',
};
// Kinds whose lines are consequences worth reading (who joins which group, what is reachable, the exact commands)
// start open, as in the lab; long inventories (packages, files, services) wait for a tap.
const OPEN_KINDS: ReadonlySet<MachineSetupChangeKind> = new Set(['users', 'ports', 'commands']);

/** One kind of change: its count in the row, the exact operands beneath it (lab `setup/review` Changes). */
export function MachineSetupChangeGroupRow(
  props: Readonly<{
    group: MachineSetupChangeGroup;
    testID: string;
    nameOf: (machineId: string) => string;
    /** A line every target makes reads bare; one only some Machines make names them. */
    targetCount: number;
    showDivider?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { group } = props;
  const [expanded, setExpanded] = React.useState(OPEN_KINDS.has(group.kind));
  const counts = [
    group.added
      ? group.kind === 'packages'
        ? t('machinePresets.setup.review.toInstall', { count: group.added })
        : t('machinePresets.setup.review.changes', { count: group.added })
      : null,
    group.removed
      ? t('machinePresets.setup.review.toRemove', { count: group.removed })
      : null,
  ].filter((value): value is string => value !== null);
  // Only package sources: nothing to install, still a change each.
  if (counts.length === 0) counts.push(t('machinePresets.setup.review.changes', { count: group.lines.length }));
  return (
    <ExpandableItem
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={props.showDivider}
      header={({ headerProps }) => (
        <Item
          {...headerProps}
          testID={props.testID}
          title={t(`machinePresets.setup.review.changeKinds.${group.kind}`)}
          detail={counts.join(' · ')}
          icon={
            <Icon
              name={CHANGE_ICONS[group.kind]}
              size={ICON_SIZE.md}
              color={theme.colors.text.secondary}
            />
          }
        />
      )}
    >
      <SectionContentRow
        continuesRow
        showDivider={false}
        leading={<View style={changeStyles.leading} />}
        testID={`${props.testID}.lines`}
      >
        <View style={changeStyles.lines}>
          {group.lines.map((line, index) => {
            const machines = line.machineIds.length < props.targetCount ? (
              <Text variant="body" style={{ color: theme.colors.text.secondary }}>
                {` · ${line.machineIds.map(props.nameOf).join(', ')}`}
              </Text>
            ) : null;
            // Ports and restarts read as words; every other line is the exact operand, a removal marked.
            if (line.publicPorts || line.note) {
              const words = line.publicPorts
                ? t('machinePresets.setup.review.fromOutside', { ports: joinList(line.publicPorts.map(String)) })
                : line.note === 'reboot'
                  ? t('machinePresets.setup.review.restartsMachine')
                  : t('machinePresets.setup.review.firewallChanges');
              return (
                <Text key={index} variant="body" style={{ color: theme.colors.text.primary }}>
                  {words}
                  {machines}
                </Text>
              );
            }
            return (
              <Text key={index} variant="body">
                {line.removes ? '− ' : null}
                <Text
                  selectable
                  style={[changeStyles.operand, { color: line.removes ? theme.colors.text.secondary : theme.colors.text.primary }]}
                >
                  {line.operand}
                </Text>
                {machines}
              </Text>
            );
          })}
        </View>
      </SectionContentRow>
    </ExpandableItem>
  );
}

const changeStyles = StyleSheet.create((theme) => ({
  leading: { width: ICON_SIZE.md },
  lines: { gap: theme.space.s4 },
  operand: { ...Typography.mono() },
}));

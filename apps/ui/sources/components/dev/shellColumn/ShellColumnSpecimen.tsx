import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_SHELL_RAIL_STEP_PX } from '@happier-dev/plugin-ui/presentation';

import {
  APP_RAIL_ITEM_SIZE_PX,
  APP_RAIL_PADDING_TOP_PX,
  APP_RAIL_WIDTH_PX,
} from '@/components/navigation/shell/appRail/appRailMetrics';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  CollectionList,
  CollectionListGroupLabel,
  CollectionNavigationRow,
  CollectionShellColumnSurfaceContext,
} from '@/components/ui/lists/collection/CollectionList';
import {
  CollectionSpacesStrip,
  type CollectionSpacesStripItem,
} from '@/components/ui/lists/collection/CollectionSpacesStrip';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The shell column's header and rhythm (owner shell round 2 items 2–3, SHELL-ACCEPT-1116): the real
 * `CollectionList` in the shell column, beside rail slots drawn from the rail's own metrics, with no band, a view
 * band (Services' grouping switch) and a spaces strip (Sessions). Every row and band centre should fall on a rail
 * step: the guide lines mark them.
 */
type Frame = Readonly<{
  id: string;
  title: string;
  band: 'none' | 'view' | 'spaces';
}>;

const FRAMES: readonly Frame[] = [
  { id: 'plain', title: 'No band (Machines, Settings)', band: 'none' },
  { id: 'view', title: 'View band (Services, Workflows)', band: 'view' },
  { id: 'spaces', title: 'Spaces strip (Sessions)', band: 'spaces' },
];

const SPACES: readonly CollectionSpacesStripItem[] = [
  { id: 'mine', name: 'My work', icon: { kind: 'icon', name: 'action' } },
  { id: 'reviews', name: 'Reviews', icon: { kind: 'icon', name: 'preview' } },
  { id: 'infra', name: 'Infra', icon: { kind: 'icon', name: 'terminal' } },
];

type Grouping = 'all' | 'project' | 'type';
const NOOP = () => {};
const GUIDE_COUNT = 10;

/** A column row as the shell's columns draw them: the navigation row with its glyph (Settings, Machines). */
function SpecimenRow(props: Readonly<{ id: string; title: string; icon: IconName; selected?: boolean }>) {
  return (
    <CollectionNavigationRow
      rowRole="item"
      testID={`shell-column-specimen-${props.id}`}
      title={props.title}
      icon={<Icon name={props.icon} size={ICON_SIZE.md} />}
      selected={props.selected === true}
      onPress={NOOP}
    />
  );
}

function ShellColumnFrame(props: Readonly<{ frame: Frame }>) {
  const [space, setSpace] = React.useState('mine');
  const [grouping, setGrouping] = React.useState<Grouping>('all');
  const [query, setQuery] = React.useState('');
  const strip =
    props.frame.band === 'view' ? (
      <SegmentedTabBar<Grouping>
        testIDPrefix={`shell-column-specimen-${props.frame.id}:grouping`}
        accessibilityLabel="Grouping"
        role="radiogroup"
        compact
        segmentSizing="content"
        tabs={[
          {
            id: 'all',
            label: 'All',
            icon: <Icon name="list-bullets" size={15} />,
          },
          {
            id: 'project',
            label: 'By project',
            icon: <Icon name="folder" size={15} />,
          },
          {
            id: 'type',
            label: 'By type',
            icon: <Icon name="squares-four" size={15} />,
          },
        ]}
        activeTabId={grouping}
        onSelectTab={setGrouping}
      />
    ) : props.frame.band === 'spaces' ? (
      <CollectionSpacesStrip
        testIDPrefix={`shell-column-specimen-${props.frame.id}:spaces`}
        accessibilityLabel="Spaces"
        items={SPACES}
        selectedId={space}
        onSelect={setSpace}
        addLabel="New space"
        onAdd={NOOP}
      />
    ) : undefined;
  return (
    <View style={styles.shell}>
      <View style={styles.rail}>
        {Array.from({ length: 4 }, (_, index) => (
          <View key={index} style={styles.railItem} />
        ))}
      </View>
      <View style={styles.column}>
        <CollectionShellColumnSurfaceContext.Provider value="plane">
          <CollectionList
            testID={`shell-column-specimen-${props.frame.id}:list`}
            title={
              props.frame.band === 'spaces'
                ? 'My work'
                : props.frame.band === 'view'
                  ? 'Services'
                  : 'Machines'
            }
            headerAction={
              <IconButton
                iconName="plus"
                accessibilityLabel="Add"
                variant="plain"
                onPress={NOOP}
              />
            }
            search={{
              value: query,
              onChangeText: setQuery,
              placeholder: 'Search',
              testID: `shell-column-specimen-${props.frame.id}:search`,
            }}
            {...(strip ? { strip } : {})}
          >
            <SpecimenRow id={`${props.frame.id}:overview`} title="Overview" icon="squares-four" selected />
            <SpecimenRow id={`${props.frame.id}:activity`} title="Activity" icon="clock" />
            <CollectionListGroupLabel title="Your machines" />
            <SpecimenRow id={`${props.frame.id}:build-box`} title="Build box" icon="desktop" />
            <SpecimenRow id={`${props.frame.id}:macbook`} title="MacBook Pro" icon="desktop" />
          </CollectionList>
        </CollectionShellColumnSurfaceContext.Provider>
      </View>
      {/* Rail-step guides: the title row's centre, then one per step. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {Array.from({ length: GUIDE_COUNT }, (_, index) => (
          <View
            key={index}
            style={[
              styles.guide,
              {
                top:
                  APP_RAIL_PADDING_TOP_PX +
                  HAPPIER_SHELL_RAIL_STEP_PX / 2 +
                  index * HAPPIER_SHELL_RAIL_STEP_PX,
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

export function ShellColumnSpecimen(props: Readonly<{ only: string | null }>) {
  const frames = props.only
    ? FRAMES.filter((frame) => frame.id === props.only)
    : FRAMES;
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.grid}>
        {frames.map((frame) => (
          <View
            key={frame.id}
            testID={`shell-column-specimen-${frame.id}`}
            style={styles.frame}
          >
            {props.only ? null : (
              <Text style={styles.caption}>{frame.title}</Text>
            )}
            <ShellColumnFrame frame={frame} />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.inset },
  content: { padding: theme.space.s16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s24 },
  caption: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
    paddingBottom: theme.space.s8,
  },
  frame: { width: APP_RAIL_WIDTH_PX + 300 },
  shell: {
    height: 480,
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: theme.colors.background.canvas,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  rail: {
    width: APP_RAIL_WIDTH_PX,
    paddingTop: APP_RAIL_PADDING_TOP_PX,
    alignItems: 'center',
  },
  railItem: {
    width: APP_RAIL_ITEM_SIZE_PX,
    height: APP_RAIL_ITEM_SIZE_PX,
    marginVertical: (HAPPIER_SHELL_RAIL_STEP_PX - APP_RAIL_ITEM_SIZE_PX) / 2,
    borderRadius: theme.space.s8,
    backgroundColor: theme.colors.surface.selected,
  },
  column: { flex: 1 },
  guide: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.status.error,
    opacity: 0.35,
  },
}));

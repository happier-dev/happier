import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';

type Page = Readonly<{
  id: string;
  label: string;
  icon: IconName;
  count?: string;
  countTone?: 'warning' | 'danger';
}>;

const PROJECT_PAGES: readonly Page[] = [
  { id: 'overview', label: 'Overview', icon: 'house' },
  { id: 'sessions', label: 'Sessions', icon: 'chats-circle', count: '6' },
  { id: 'changes', label: 'Changes', icon: 'git-diff', count: '14' },
  { id: 'deployments', label: 'Deployments', icon: 'rocket-launch' },
  {
    id: 'services',
    label: 'Services',
    icon: 'stack',
    count: '3',
    countTone: 'warning',
  },
  { id: 'logs', label: 'Logs', icon: 'scroll' },
  { id: 'settings', label: 'Settings', icon: 'sliders-horizontal' },
];
const MACHINE_PAGES: readonly Page[] = [
  { id: 'overview', label: 'Overview', icon: 'house' },
  { id: 'sessions', label: 'Sessions', icon: 'chats-circle', count: '4' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal-window' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'services', label: 'Services', icon: 'stack', count: '9' },
  {
    id: 'security',
    label: 'Security',
    icon: 'shield-check',
    count: '3',
    countTone: 'warning',
  },
  { id: 'settings', label: 'Settings', icon: 'sliders-horizontal' },
];
const STORE_FILTERS = [
  'All',
  'Agents',
  'Providers',
  'Plugins',
  'Themes',
  'Channels',
  'Automations',
];
const NARROW_WIDTHS = [320, 240] as const;

/**
 * Dev-only specimen for the one tab-bar owner: every presentation (segmented, plain, pills), a
 * fitting row with More at full and narrow widths, and a value choice that turns into its select.
 * Mounts `SegmentedTabBar` itself with fixture tabs; nothing here draws a tab.
 */
export function TabBarSpecimen() {
  const { theme } = useUnistyles();
  const toTab = React.useCallback(
    (page: Page): SegmentedTab<string> => ({
      id: page.id,
      label: page.label,
      icon: (
        <Icon
          name={page.icon}
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
      ),
      ...(page.count ? { count: page.count } : {}),
      ...(page.countTone ? { countTone: page.countTone } : {}),
    }),
    [theme.colors.text.secondary],
  );
  const projectTabs = React.useMemo(() => PROJECT_PAGES.map(toTab), [toTab]);
  const machineTabs = React.useMemo(
    () => MACHINE_PAGES.map(({ icon: _icon, ...page }) => page),
    [],
  );
  const storeTabs = React.useMemo(
    () => STORE_FILTERS.map((label) => ({ id: label.toLowerCase(), label })),
    [],
  );
  const [inbox, setInbox] = React.useState('all');
  const [project, setProject] = React.useState('services');
  const [machine, setMachine] = React.useState('overview');
  const [store, setStore] = React.useState('all');
  const [effort, setEffort] = React.useState<string | null>('medium');
  const more = { label: 'More' };

  const section = (
    title: string,
    render: (width: number | null) => React.ReactNode,
  ) => (
    <View style={styles.section} key={title}>
      <Text variant="heading">{title}</Text>
      {[null, ...NARROW_WIDTHS].map((width) => (
        <View key={width ?? 'full'} style={styles.sample}>
          <Text variant="meta" style={styles.caption}>
            {width === null ? 'Full width' : `${width} px`}
          </Text>
          <View style={width === null ? styles.full : { width }}>
            {render(width)}
          </View>
        </View>
      ))}
    </View>
  );

  return (
    <ScrollView
      testID="tab-bar-specimen"
      style={styles.root}
      contentContainerStyle={styles.content}
    >
      {section('Segmented, equal (Inbox)', () => (
        <SegmentedTabBar
          tabs={[
            { id: 'all', label: 'All' },
            {
              id: 'needs',
              label: 'Needs you',
              count: '2',
              countTone: 'warning',
            },
            { id: 'mentions', label: 'Mentions' },
          ]}
          activeTabId={inbox}
          onSelectTab={setInbox}
          accessibilityLabel="Inbox view"
          testIDPrefix="specimen-inbox"
        />
      ))}
      {section('Segmented, content, fits with More (Machine page)', (width) => (
        <SegmentedTabBar
          tabs={machineTabs}
          activeTabId={machine}
          onSelectTab={setMachine}
          segmentSizing="content"
          overflow={more}
          accessibilityLabel="Machine pages"
          testIDPrefix={`specimen-machine-${width ?? 'full'}`}
        />
      ))}
      {section(
        'Plain, glyphs and counts, fits with More (Project header)',
        (width) => (
          <SegmentedTabBar
            presentation="plain"
            tabs={projectTabs}
            activeTabId={project}
            onSelectTab={setProject}
            segmentSizing="content"
            overflow={{
              ...more,
              actions: [
                {
                  id: 'customize',
                  label: 'Customize tabs…',
                  onPress: () => {},
                },
              ],
            }}
            accessibilityLabel="Project pages"
            testIDPrefix={`specimen-project-${width ?? 'full'}`}
          />
        ),
      )}
      {section('Pills, fits with More (Store filters)', (width) => (
        <SegmentedTabBar
          presentation="pills"
          tabs={storeTabs}
          activeTabId={store}
          onSelectTab={setStore}
          segmentSizing="content"
          overflow={more}
          accessibilityLabel="Store filter"
          testIDPrefix={`specimen-store-${width ?? 'full'}`}
        />
      ))}
      {section(
        'Value choice, becomes a select when it no longer fits',
        (width) => (
          <SegmentedTabBar
            role="radiogroup"
            tabs={['Minimal', 'Low', 'Medium', 'High', 'Extra high'].map(
              (label) => ({ id: label.toLowerCase(), label }),
            )}
            activeTabId={effort}
            onSelectTab={setEffort}
            segmentSizing="equal-or-label"
            overflow={more}
            accessibilityLabel="Reasoning effort"
            testIDPrefix={`specimen-effort-${width ?? 'full'}`}
          />
        ),
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.base },
  content: { padding: theme.space.s24, gap: theme.space.s32 },
  section: { gap: theme.space.s12 },
  sample: { gap: theme.space.s6 },
  full: { alignSelf: 'stretch' },
  caption: { color: theme.colors.text.tertiary },
}));

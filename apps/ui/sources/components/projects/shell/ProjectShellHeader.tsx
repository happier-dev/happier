import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  HAPPIER_SEGMENTED_METRICS,
  happierFocusRingStyle,
  happierPageTextMetrics,
  isHappierFocusVisible,
} from '@happier-dev/plugin-ui/presentation';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { GROUPED_SURFACE_RADIUS_PX } from '@/components/ui/lists/pageListMetrics';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  HEADER_BAND_HORIZONTAL_PADDING_PX,
  HEADER_BAND_TITLE_TEXT,
} from '@/components/ui/layout/headerBand';
import {
  PageHeaderMenu,
  type PageHeaderMenuAction,
} from '@/components/ui/layout/PageHeaderEntityParts';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';

import type { ProjectPageV1 } from '@/components/workspaceCockpit/project/projectCockpitState';

/** One page in the header's tabs (D44): the route's page id, its glyph and an optional quiet count. */
export type ProjectShellPage = Readonly<{ id: ProjectPageV1; count?: string }>;

const PAGE_GLYPHS: Readonly<Record<ProjectPageV1, IconName>> = {
  overview: 'list-bullets',
  code: 'code',
  changes: 'git-branch',
  scripts: 'play',
  services: 'hard-drives',
  context: 'stack',
};

export function projectPageLabel(page: ProjectPageV1): string {
  switch (page) {
    case 'overview':
      return t('projects.pages.overview');
    case 'code':
      return t('projects.pages.code');
    case 'changes':
      return t('projects.pages.changes');
    case 'scripts':
      return t('projects.pages.scripts');
    case 'services':
      return t('projects.pages.services');
    case 'context':
      return t('projects.pages.context');
  }
}

/** The checkout the page is looking at: its machine and branch, and the exact choices behind the chip. */
export type ProjectShellCheckout = Readonly<{
  machineName: string;
  machineIcon: IconName;
  /** The branch, or the folder name when the checkout is not on a branch. */
  branch: string;
  /** Every exact checkout of this Project the viewer can open, the current one checked. */
  choices: readonly DropdownMenuItem[];
  onSelect: (choiceId: string) => void;
}>;

/**
 * Below this measured band width the header keeps its identity and tabs readable by dropping the
 * chip's machine name and New session's label (lab `p-overview` FIT, a 1180 window); the tabs then
 * fit themselves by their own measurement. Not a count of tabs or a viewport class: the band's box.
 */
const COMPACT_BAND_WIDTH_PX = 960;

/**
 * The Project page header (12s1, lab `p-overview` HOME/FIT): the Project's name, the checkout chip,
 * the six page tabs on one route-owned selection, then New session and the Project's `⋯`. Tabs that
 * no longer fit the measured band move behind More; Context stays reachable there (D44).
 */
export const ProjectShellHeader = React.memo(function ProjectShellHeader(
  props: Readonly<{
    projectName: string;
    checkout: ProjectShellCheckout | null;
    pages: readonly ProjectShellPage[];
    activePage: ProjectPageV1;
    onSelectPage: (page: ProjectPageV1) => void;
    onNewSession: (() => void) | null;
    menuActions: readonly PageHeaderMenuAction[];
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const height = useHeaderHeight();
  const [bandWidth, setBandWidth] = React.useState<number | null>(null);
  const compact = bandWidth !== null && bandWidth < COMPACT_BAND_WIDTH_PX;
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setBandWidth((current) => (current === width ? current : width));
  }, []);
  const tabs = React.useMemo(
    (): ReadonlyArray<SegmentedTab<ProjectPageV1>> =>
      props.pages.map((page) => ({
        id: page.id,
        label: projectPageLabel(page.id),
        icon: (
          <Icon
            name={PAGE_GLYPHS[page.id]}
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
        ),
        ...(page.count ? { count: page.count } : {}),
      })),
    [props.pages, theme.colors.text.secondary],
  );
  const testID = props.testID ?? 'project-shell-header';

  return (
    <View
      testID={testID}
      onLayout={onLayout}
      style={[
        styles.band,
        { minHeight: height, borderBottomColor: theme.colors.border.subtle },
      ]}
    >
      <View style={styles.identity}>
        <Icon
          name="folder"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
        <Text
          numberOfLines={1}
          style={[styles.name, { color: theme.colors.text.primary }]}
          accessibilityRole="header"
        >
          {props.projectName}
        </Text>
      </View>
      {props.checkout ? (
        <ProjectCheckoutChip
          checkout={props.checkout}
          compact={compact}
          testID={`${testID}.checkout`}
        />
      ) : null}
      <View style={styles.tabs}>
        <SegmentedTabBar
          presentation="plain"
          overflow={{ label: t('common.more'), testID: `${testID}.pages.more` }}
          tabs={tabs}
          activeTabId={props.activePage}
          onSelectTab={props.onSelectPage}
          accessibilityLabel={t('projects.pages.label')}
          testIDPrefix={`${testID}.pages`}
        />
      </View>
      <View style={styles.actions}>
        {props.onNewSession ? (
          compact ? (
            <IconButton
              testID={`${testID}.newSession`}
              iconName="plus"
              variant="plain"
              accessibilityLabel={t('projects.open.newSession')}
              tooltip={t('projects.open.newSession')}
              onPress={props.onNewSession}
            />
          ) : (
            <RoundButton
              testID={`${testID}.newSession`}
              size="small"
              display="secondary"
              title={t('projects.open.newSession')}
              leading={
                <Icon
                  name="plus"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.primary}
                />
              }
              onPress={props.onNewSession}
            />
          )
        ) : null}
        {props.menuActions.length > 0 ? (
          <PageHeaderMenu
            actions={props.menuActions}
            testID={`${testID}.menu`}
          />
        ) : null}
      </View>
    </View>
  );
});

/**
 * The checkout chip: which machine and branch the whole page follows, and the exact choices behind it.
 * `row` is the phone's full-width field under the navigation bar (lab `p-overview` HOMEp).
 */
export const ProjectCheckoutChip = React.memo(function ProjectCheckoutChip(
  props: Readonly<{
    checkout: ProjectShellCheckout;
    compact: boolean;
    presentation?: 'chip' | 'row';
    testID: string;
  }>,
) {
  const row = props.presentation === 'row';
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);
  const label = t('projects.checkouts.chipLabel', {
    machine: props.checkout.machineName,
    branch: props.checkout.branch,
  });
  return (
    <DropdownMenu
      testID={`${props.testID}.menu`}
      open={open}
      onOpenChange={setOpen}
      items={props.checkout.choices}
      selectedId={
        props.checkout.choices.find((choice) => choice.checked)?.id ?? null
      }
      onSelect={(id) => {
        setOpen(false);
        props.checkout.onSelect(id);
      }}
      placement="bottom"
      matchTriggerWidth={false}
      trigger={({ toggle }) => (
        <Pressable
          testID={props.testID}
          onPress={toggle}
          onFocus={(event) =>
            setFocusVisible(isHappierFocusVisible(event?.target))
          }
          onBlur={() => setFocusVisible(false)}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: open }}
          style={({
            pressed,
            hovered,
          }: {
            pressed: boolean;
            hovered?: boolean;
          }) => [
            styles.chip,
            row ? styles.row : null,
            HAPPIER_FOCUS_RING_DELEGATED_STYLE,
            {
              borderColor: theme.colors.border.default,
              backgroundColor:
                open || hovered || pressed
                  ? theme.colors.surface.selected
                  : theme.colors.surface.base,
            },
            happierFocusRingStyle({
              visible: focusVisible,
              color: theme.colors.border.focus,
            }),
          ]}
        >
          {props.compact ? null : (
            <>
              <Icon
                name={props.checkout.machineIcon}
                size={row ? ICON_SIZE.sm : ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.chipText,
                  row ? styles.rowText : null,
                  { color: theme.colors.text.secondary },
                ]}
              >
                {row ? `${props.checkout.machineName} ·` : props.checkout.machineName}
              </Text>
            </>
          )}
          {row ? null : (
            <Icon
              name="git-branch"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
          )}
          <Text
            numberOfLines={1}
            style={[
              styles.chipText,
              styles.chipBranch,
              row ? styles.rowText : null,
              { color: theme.colors.text.primary },
            ]}
          >
            {props.checkout.branch}
          </Text>
          {row ? <View style={styles.grow} /> : null}
          <Icon
            name="caret-down"
            size={row ? ICON_SIZE.xs : 12}
            color={theme.colors.text.tertiary}
          />
        </Pressable>
      )}
    />
  );
});

const styles = StyleSheet.create(() => ({
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minWidth: 0,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 220,
  },
  name: {
    ...Typography.default('semiBold'),
    fontSize: HEADER_BAND_TITLE_TEXT.fontSize,
    flexShrink: 1,
  },
  tabs: { flex: 1, minWidth: 0, marginLeft: 4 },
  grow: { flex: 1 },
  // The phone row is a touch field: the platform target height, the content width, a card's radius.
  row: {
    height: resolveMinimumInteractiveTargetSize(Platform.OS),
    maxWidth: '100%',
    alignSelf: 'stretch',
    borderRadius: GROUPED_SURFACE_RADIUS_PX,
    paddingHorizontal: 14,
    gap: 8,
  },
  rowText: { ...Typography.default(), ...happierPageTextMetrics('rowTitle') },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: HAPPIER_SEGMENTED_METRICS.plain.paddingVerticalPx * 2 + HAPPIER_SEGMENTED_METRICS.plain.labelSlotPx,
    paddingHorizontal: 9,
    borderRadius: HAPPIER_SEGMENTED_METRICS.plain.radiusPx,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 320,
  },
  chipText: { ...Typography.default(), fontSize: HAPPIER_SEGMENTED_METRICS.plain.labelFontSizePx, flexShrink: 1 },
  chipBranch: { ...Typography.default('semiBold') },
}));

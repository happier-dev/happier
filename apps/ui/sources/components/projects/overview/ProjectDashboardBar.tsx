import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  happierFocusRingStyle,
  isHappierFocusVisible,
} from '@happier-dev/plugin-ui/presentation';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { t } from '@/text';

/** One dashboard in the Overview selector: the default Overview, a named one, or one shared with you. */
export type ProjectDashboardOption = Readonly<{
  id: string;
  name: string;
  isDefault: boolean;
  /** Set for a dashboard someone else owns: its owner's mark in the switcher (lab `p-overview` TEAM). */
  sharedBy?: Readonly<{ accountId: string; name: string; imageUrl?: string | null }>;
  /** An attached dashboard this viewer can no longer open. */
  unavailable?: boolean;
}>;

/** The `⋯` actions on the exact selected dashboard; each is absent when it cannot apply to this viewer. */
export type ProjectDashboardActions = Readonly<{
  share?: () => void;
  /** Attach this document to a Team Source you manage (10's attachment reference). */
  attach?: Readonly<{
    header: string;
    sources: readonly Readonly<{
      id: string;
      name: string;
      address: string;
      attached: boolean;
    }>[];
    onToggle: (sourceId: string) => void;
    /** The Team Sources are read only when the menu that lists them is opened. */
    onDemand?: () => void;
  }>;
  rename?: () => void;
  moveBefore?: Readonly<{ name: string; onPress: () => void }>;
  moveAfter?: Readonly<{ name: string; onPress: () => void }>;
  /** Delete, or the owner's reason it cannot be deleted (the default dashboard). */
  delete?: Readonly<{ onPress: () => void } | { disabledReason: string }>;
}>;

/**
 * The Overview's dashboard bar (12s3, lab `p-overview` HOME/FIT/MENU): the dashboards as one segmented
 * switcher on a wide pane, the current name as a menu on a narrow one; `+` creates a dashboard (the
 * existing prompt) and `⋯` acts on the exact selected document. Switching writes nothing.
 */
export const ProjectDashboardBar = React.memo(function ProjectDashboardBar(
  props: Readonly<{
    dashboards: readonly ProjectDashboardOption[];
    selectedId: string;
    onSelect: (dashboardId: string) => void;
    /** The current-name menu replaces the switcher (narrow pane, phone). */
    narrow: boolean;
    onCreate: (() => void) | null;
    actions: ProjectDashboardActions | null;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const testID = props.testID ?? 'project-dashboards';
  const selected =
    props.dashboards.find((dashboard) => dashboard.id === props.selectedId) ??
    props.dashboards[0] ??
    null;
  const ownerMark = React.useCallback(
    (dashboard: ProjectDashboardOption, size: number) =>
      dashboard.sharedBy ? (
        <Avatar id={dashboard.sharedBy.accountId} size={size} imageUrl={dashboard.sharedBy.imageUrl ?? null} />
      ) : null,
    [],
  );
  const tabs = React.useMemo(
    (): ReadonlyArray<SegmentedTab<string>> =>
      props.dashboards.map((dashboard) => ({
        id: dashboard.id,
        label: dashboard.name,
        ...(dashboard.sharedBy ? { icon: ownerMark(dashboard, 14) } : {}),
      })),
    [ownerMark, props.dashboards],
  );

  return (
    <View testID={testID} style={styles.bar}>
      {props.narrow ? (
        <DashboardCurrentNameMenu
          dashboards={props.dashboards}
          selected={selected}
          onSelect={props.onSelect}
          onCreate={props.onCreate}
          ownerMark={ownerMark}
          testID={`${testID}.current`}
        />
      ) : (
        <View style={styles.switcher}>
          <SegmentedTabBar
            tabs={tabs}
            activeTabId={selected?.id ?? props.selectedId}
            onSelectTab={props.onSelect}
            slidingThumb
            segmentSizing="content"
            accessibilityLabel={t('projects.dashboard.label')}
            testIDPrefix={`${testID}.tabs`}
          />
        </View>
      )}
      <View style={styles.grow} />
      {props.onCreate && !props.narrow ? (
        <IconButton
          testID={`${testID}.create`}
          iconName="plus"
          variant="plain"
          accessibilityLabel={t('projects.dashboard.create')}
          tooltip={t('projects.dashboard.create')}
          onPress={props.onCreate}
        />
      ) : null}
      {props.actions && selected ? (
        <DashboardActionsMenu
          name={selected.name}
          actions={props.actions}
          testID={`${testID}.actions`}
        />
      ) : null}
    </View>
  );
});

/** Narrow panes and phones: the selected dashboard's name opens the list, with Create at its end. */
function DashboardCurrentNameMenu(
  props: Readonly<{
    dashboards: readonly ProjectDashboardOption[];
    selected: ProjectDashboardOption | null;
    onSelect: (dashboardId: string) => void;
    onCreate: (() => void) | null;
    ownerMark: (
      dashboard: ProjectDashboardOption,
      size: number,
    ) => React.ReactNode;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);
  const CREATE = '\u0000create';
  const items = React.useMemo(
    (): DropdownMenuItem[] => [
      ...props.dashboards.map((dashboard) => ({
        id: dashboard.id,
        title: dashboard.name,
        category: 'dashboards',
        icon: props.ownerMark(dashboard, 18) ?? (
          <Icon
            name={dashboard.isDefault ? 'list-bullets' : 'squares-four'}
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
        ),
        ...(dashboard.isDefault
          ? { subtitle: t('projects.dashboard.default') }
          : {}),
        checked: dashboard.id === props.selected?.id,
        testID: `${props.testID}.option.${dashboard.id}`,
      })),
      ...(props.onCreate
        ? [
            {
              id: CREATE,
              title: t('projects.dashboard.createEllipsis'),
              category: 'create',
              icon: (
                <Icon
                  name="plus"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              ),
              testID: `${props.testID}.create`,
            },
          ]
        : []),
    ],
    [CREATE, props, theme.colors.text.secondary],
  );
  const name = props.selected?.name ?? '';
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={props.selected?.id ?? null}
      onSelect={(id) => {
        setOpen(false);
        if (id === CREATE) props.onCreate?.();
        else props.onSelect(id);
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
          accessibilityLabel={t('projects.dashboard.current', { name })}
          accessibilityState={{ expanded: open }}
          style={[
            styles.current,
            HAPPIER_FOCUS_RING_DELEGATED_STYLE,
            happierFocusRingStyle({
              visible: focusVisible,
              color: theme.colors.border.focus,
            }),
          ]}
        >
          {props.selected ? props.ownerMark(props.selected, 16) : null}
          <Text
            numberOfLines={1}
            style={[styles.currentName, { color: theme.colors.text.primary }]}
          >
            {name}
          </Text>
          <Icon
            name="caret-down"
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
        </Pressable>
      )}
    />
  );
}

/** `⋯` on the selected document: Share and Attach, then Rename and Move, then Delete last. */
function DashboardActionsMenu(
  props: Readonly<{
    name: string;
    actions: ProjectDashboardActions;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const glyph = (name: React.ComponentProps<typeof Icon>['name']) => (
    <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
  );
  const { actions } = props;
  const items = React.useMemo((): DropdownMenuItem[] => {
    const list: DropdownMenuItem[] = [];
    if (actions.share)
      list.push({
        id: 'share',
        title: t('projects.dashboard.share'),
        category: 'share',
        icon: glyph('share'),
        testID: `${props.testID}.share`,
      });
    if (actions.attach) {
      list.push({
        id: 'attach',
        title: t('projects.dashboard.attach'),
        category: 'share',
        icon: glyph('link'),
        testID: `${props.testID}.attach`,
        submenu: {
          items: actions.attach.sources.map((source) => ({
            id: `source:${source.id}`,
            title: source.name,
            subtitle: source.address,
            category: actions.attach!.header,
            icon: glyph('git-branch'),
            checked: source.attached,
            testID: `${props.testID}.attach.${source.id}`,
          })),
          emptyLabel: t('projects.dashboard.attachNone'),
        },
      });
    }
    if (actions.rename)
      list.push({
        id: 'rename',
        title: t('projects.dashboard.rename'),
        category: 'edit',
        icon: glyph('pencil-simple'),
        testID: `${props.testID}.rename`,
      });
    if (actions.moveBefore)
      list.push({
        id: 'moveBefore',
        title: t('projects.dashboard.moveBefore', {
          name: actions.moveBefore.name,
        }),
        category: 'edit',
        icon: glyph('arrow-up'),
        testID: `${props.testID}.moveBefore`,
      });
    if (actions.moveAfter)
      list.push({
        id: 'moveAfter',
        title: t('projects.dashboard.moveAfter', {
          name: actions.moveAfter.name,
        }),
        category: 'edit',
        icon: glyph('arrow-down'),
        testID: `${props.testID}.moveAfter`,
      });
    if (actions.delete) {
      const disabledReason =
        'disabledReason' in actions.delete
          ? actions.delete.disabledReason
          : null;
      list.push({
        id: 'delete',
        title: disabledReason
          ? t('projects.dashboard.deleteLabel')
          : t('projects.dashboard.delete'),
        ...(disabledReason
          ? { subtitle: disabledReason, disabled: true }
          : { destructive: true }),
        category: 'danger',
        icon: glyph('trash'),
        testID: `${props.testID}.delete`,
      });
    }
    return list;
    // `glyph` reads only the theme colour below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, props.testID, theme.colors.text.secondary]);
  if (items.length === 0) return null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next: boolean) => {
        if (next) actions.attach?.onDemand?.();
        setOpen(next);
      }}
      items={items}
      onSelect={(id) => {
        setOpen(false);
        if (id === 'share') actions.share?.();
        else if (id === 'rename') actions.rename?.();
        else if (id === 'moveBefore') actions.moveBefore?.onPress();
        else if (id === 'moveAfter') actions.moveAfter?.onPress();
        else if (
          id === 'delete' &&
          actions.delete &&
          'onPress' in actions.delete
        )
          actions.delete.onPress();
        else if (id.startsWith('source:'))
          actions.attach?.onToggle(id.slice('source:'.length));
      }}
      placement="bottom"
      popoverAnchorAlign="end"
      matchTriggerWidth={false}
      trigger={({ toggle, open: isOpen }) => (
        <IconButton
          testID={props.testID}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('projects.dashboard.actions', {
            name: props.name,
          })}
          tooltip={t('projects.dashboard.actions', { name: props.name })}
          hasPopup="menu"
          expanded={isOpen}
          selected={isOpen}
          onPress={toggle}
        />
      )}
    />
  );
}

const styles = StyleSheet.create(() => ({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  switcher: { flexShrink: 1, minWidth: 0 },
  grow: { flex: 1 },
  current: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingVertical: 4,
    flexShrink: 1,
    minWidth: 0,
  },
  currentName: { ...pageTitleTypography(), flexShrink: 1 },
}));

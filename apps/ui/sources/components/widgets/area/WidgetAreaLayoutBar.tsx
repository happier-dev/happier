import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  happierFocusRingStyle,
  HappierTabMarker,
  HappierTabs,
  isHappierFocusVisible,
  type HappierTabDescriptor,
} from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** One named layout of an area: a host preset, one of the viewer's own, or one shared with them. */
export type WidgetAreaLayoutOption = Readonly<{
  id: string;
  name: string;
  /** The area's stock layout (the narrow list says so under its name). */
  isDefault?: boolean;
  /** A host's own mark for the layout (Usage's views); absent where layouts are told apart by name. */
  icon?: IconName;
  /** Set for a layout someone else owns: its owner's mark instead of an icon. */
  sharedBy?: Readonly<{
    accountId: string;
    name: string;
    imageUrl?: string | null;
  }>;
  /** A preset this viewer has edited (lab wgsaved R): a quiet dot on its tab. */
  edited?: boolean;
}>;

/** The `⋯` actions on the exact selected layout; each is absent when it cannot apply to this viewer. */
export type WidgetAreaLayoutActions = Readonly<{
  share?: () => void;
  /** Attach this document to a Team Source the viewer manages. */
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
  /** Delete, or the owner's reason it cannot be deleted (the default layout). */
  delete?: Readonly<{ onPress: () => void } | { disabledReason: string }>;
}>;

/** The words an area owner uses for its named layouts ("dashboard" in a Project, "view" on Usage). */
export type WidgetAreaLayoutLabels = Readonly<{
  /** The tab list's name ("Dashboards"). */
  list: string;
  /** The selected layout as the narrow selector announces it ("Dashboard: Release"). */
  current: (name: string) => string;
  create: string;
  /** Create in the narrow list, where it opens a naming prompt. */
  createEllipsis: string;
  /** Said under the stock layout's name in the narrow list. */
  defaultLayout?: string;
  actions: (name: string) => string;
  rename: string;
  moveBefore: (name: string) => string;
  moveAfter: (name: string) => string;
  delete: string;
  /** Delete while it is unavailable (its row then carries the reason). */
  deleteLabel: string;
}>;

/** The words every area shares for an edited preset's dot. */
function editedMarker(option: WidgetAreaLayoutOption): string | undefined {
  return option.edited ? t('widgetFrame.presetEdited') : undefined;
}

/** A tab descriptor: `HappierTabs` reads its props; the widget area below the bar is the panel. */
function LayoutTab(_props: HappierTabDescriptor): null {
  return null;
}

/**
 * The one tab bar for an area's named layouts (lab wgsaved R, `d2views`, `p-overview`): every area
 * owner — a Project's dashboards, a core page's views, a plugin area's layouts — draws it. Underlined
 * tabs with the edited dot, `+` to create from the current layout and `⋯` on the exact selected one at
 * the trailing edge; on a narrow pane the current name opens the same list. Switching writes nothing.
 * The inventory (names, order, `isEdited`) comes from `useWidgetAreaLayouts`.
 */
export const WidgetAreaLayoutBar = React.memo(function WidgetAreaLayoutBar(
  props: Readonly<{
    layouts: readonly WidgetAreaLayoutOption[];
    selectedId: string;
    onSelect: (layoutId: string) => void;
    /** The current-name menu replaces the tabs (narrow pane, phone). */
    narrow: boolean;
    onCreate: (() => void) | null;
    actions: WidgetAreaLayoutActions | null;
    labels: WidgetAreaLayoutLabels;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const tabsTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const { testID, labels } = props;
  const selected =
    props.layouts.find((layout) => layout.id === props.selectedId) ??
    props.layouts[0] ??
    null;
  const selectedId = selected?.id ?? props.selectedId;
  const create = props.onCreate ? (
    <IconButton
      testID={`${testID}.create`}
      iconName="plus"
      variant="plain"
      accessibilityLabel={labels.create}
      tooltip={labels.create}
      onPress={props.onCreate}
    />
  ) : null;
  const actions =
    props.actions && selected ? (
      <WidgetAreaLayoutActionsMenu
        name={selected.name}
        actions={props.actions}
        labels={labels}
        testID={`${testID}.actions`}
      />
    ) : null;

  if (props.narrow) {
    return (
      <View testID={testID} style={styles.narrow}>
        <LayoutCurrentNameMenu
          layouts={props.layouts}
          selected={selected}
          onSelect={props.onSelect}
          onCreate={props.onCreate}
          labels={labels}
          testID={`${testID}.current`}
        />
        <View style={styles.grow} />
        {actions}
      </View>
    );
  }
  return (
    <View testID={testID} style={styles.bar}>
      <CoreCollectionScope>
        <HappierTabs
          theme={tabsTheme}
          value={selectedId}
          onValueChange={props.onSelect}
          ariaLabel={labels.list}
          sharedPanel={null}
          testID={`${testID}.tabs`}
          {...(actions || create
            ? {
                trailing: (
                  <View style={styles.trailing}>
                    {actions}
                    {create}
                  </View>
                ),
              }
            : {})}
        >
          {props.layouts.map((layout) => (
            <LayoutTab
              key={layout.id}
              value={layout.id}
              title={layout.name}
              marker={editedMarker(layout)}
              icon={
                layout.sharedBy ? (
                  <Avatar
                    id={layout.sharedBy.accountId}
                    size={ICON_SIZE.sm}
                    imageUrl={layout.sharedBy.imageUrl ?? null}
                  />
                ) : layout.icon ? (
                  <Icon
                    name={layout.icon}
                    size={ICON_SIZE.sm}
                    color={
                      layout.id === selectedId
                        ? theme.colors.text.primary
                        : theme.colors.text.secondary
                    }
                  />
                ) : undefined
              }
            />
          ))}
        </HappierTabs>
      </CoreCollectionScope>
    </View>
  );
});

/** Narrow panes and phones: the selected layout's name opens the list, with Create at its end. */
function LayoutCurrentNameMenu(
  props: Readonly<{
    layouts: readonly WidgetAreaLayoutOption[];
    selected: WidgetAreaLayoutOption | null;
    onSelect: (layoutId: string) => void;
    onCreate: (() => void) | null;
    labels: WidgetAreaLayoutLabels;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);
  const CREATE = '\u0000create';
  const { layouts, labels, onCreate, testID } = props;
  const selectedId = props.selected?.id;
  const items = React.useMemo(
    (): DropdownMenuItem[] => [
      ...layouts.map((layout) => {
        const marker = editedMarker(layout);
        return {
          id: layout.id,
          title: layout.name,
          ...(marker
            ? {
                accessibilityLabel: `${layout.name} ${marker}`,
                rightElement: (
                  <HappierTabMarker
                    color={theme.colors.text.tertiary}
                    testID={`${testID}.option.${layout.id}:marker`}
                  />
                ),
              }
            : {}),
          category: 'layouts',
          icon: layout.sharedBy ? (
            <Avatar
              id={layout.sharedBy.accountId}
              size={18}
              imageUrl={layout.sharedBy.imageUrl ?? null}
            />
          ) : (
            <Icon
              name={
                layout.icon ??
                (layout.isDefault ? 'list-bullets' : 'squares-four')
              }
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
          ),
          ...(layout.isDefault && labels.defaultLayout
            ? { subtitle: labels.defaultLayout }
            : {}),
            checked: layout.id === selectedId,
          testID: `${testID}.option.${layout.id}`,
        };
      }),
      ...(onCreate
        ? [
            {
              id: CREATE,
              title: labels.createEllipsis,
              category: 'create',
              icon: (
                <Icon
                  name="plus"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              ),
              testID: `${testID}.create`,
            },
          ]
        : []),
    ],
    [
      CREATE,
      labels,
      layouts,
      onCreate,
      selectedId,
      testID,
      theme.colors.text.secondary,
      theme.colors.text.tertiary,
    ],
  );
  const name = props.selected?.name ?? '';
  const marker = props.selected ? editedMarker(props.selected) : undefined;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={selectedId ?? null}
      onSelect={(id) => {
        setOpen(false);
        if (id === CREATE) onCreate?.();
        else props.onSelect(id);
      }}
      placement="bottom"
      matchTriggerWidth={false}
      trigger={({ toggle }) => (
        <Pressable
          testID={testID}
          onPress={toggle}
          onFocus={(event) =>
            setFocusVisible(isHappierFocusVisible(event?.target))
          }
          onBlur={() => setFocusVisible(false)}
          accessibilityRole="button"
          accessibilityLabel={[labels.current(name), marker]
            .filter(Boolean)
            .join(' ')}
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
          {props.selected?.sharedBy ? (
            <Avatar
              id={props.selected.sharedBy.accountId}
              size={ICON_SIZE.sm}
              imageUrl={props.selected.sharedBy.imageUrl ?? null}
            />
          ) : null}
          <Text
            numberOfLines={1}
            style={[styles.currentName, { color: theme.colors.text.primary }]}
          >
            {name}
          </Text>
          {marker ? (
            <HappierTabMarker
              color={theme.colors.text.tertiary}
              testID={`${testID}:marker`}
            />
          ) : null}
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

/** `⋯` on the selected layout: Share and Attach, then Rename and Move, then Delete last. */
function WidgetAreaLayoutActionsMenu(
  props: Readonly<{
    name: string;
    actions: WidgetAreaLayoutActions;
    labels: WidgetAreaLayoutLabels;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const { actions, labels, testID } = props;
  const color = theme.colors.text.secondary;
  const items = React.useMemo((): DropdownMenuItem[] => {
    const glyph = (name: IconName) => (
      <Icon name={name} size={ICON_SIZE.sm} color={color} />
    );
    const list: DropdownMenuItem[] = [];
    if (actions.share)
      list.push({
        id: 'share',
        title: t('projects.dashboard.share'),
        category: 'share',
        icon: glyph('share'),
        testID: `${testID}.share`,
      });
    if (actions.attach) {
      const attach = actions.attach;
      list.push({
        id: 'attach',
        title: t('projects.dashboard.attach'),
        category: 'share',
        icon: glyph('link'),
        testID: `${testID}.attach`,
        submenu: {
          items: attach.sources.map((source) => ({
            id: `source:${source.id}`,
            title: source.name,
            subtitle: source.address,
            category: attach.header,
            icon: glyph('git-branch'),
            checked: source.attached,
            testID: `${testID}.attach.${source.id}`,
          })),
          emptyLabel: t('projects.dashboard.attachNone'),
        },
      });
    }
    if (actions.rename)
      list.push({
        id: 'rename',
        title: labels.rename,
        category: 'edit',
        icon: glyph('pencil-simple'),
        testID: `${testID}.rename`,
      });
    if (actions.moveBefore)
      list.push({
        id: 'moveBefore',
        title: labels.moveBefore(actions.moveBefore.name),
        category: 'edit',
        icon: glyph('arrow-up'),
        testID: `${testID}.moveBefore`,
      });
    if (actions.moveAfter)
      list.push({
        id: 'moveAfter',
        title: labels.moveAfter(actions.moveAfter.name),
        category: 'edit',
        icon: glyph('arrow-down'),
        testID: `${testID}.moveAfter`,
      });
    if (actions.delete) {
      const disabledReason =
        'disabledReason' in actions.delete
          ? actions.delete.disabledReason
          : null;
      list.push({
        id: 'delete',
        title: disabledReason ? labels.deleteLabel : labels.delete,
        ...(disabledReason
          ? { subtitle: disabledReason, disabled: true }
          : { destructive: true }),
        category: 'danger',
        icon: glyph('trash'),
        testID: `${testID}.delete`,
      });
    }
    return list;
  }, [actions, color, labels, testID]);
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
          testID={testID}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={labels.actions(props.name)}
          tooltip={labels.actions(props.name)}
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
  bar: { minWidth: 0 },
  narrow: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  trailing: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
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

import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_ICON_BUTTON_SIZE } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  useHeaderControlMetrics,
  type HeaderControlMetrics,
} from '@/components/ui/icons/iconButtonGlyphSize';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  ActionListSection,
  type ActionListItem,
} from '@/components/ui/lists/ActionListSection';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import {
  EntityFlatReorderList,
  EntityFlatReorderRow,
  type EntityFlatReorderBinding,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';

import {
  resolveCollectionColumns,
  type CollectionColumnDeclaration,
} from './collectionColumns';
import {
  buildCollectionColumnReorderBinding,
  useCollectionColumns,
  type CollectionColumnsController,
} from './useCollectionColumns';

/** One column as the Columns menu names it: the table's short header, what it shows, and where it comes from. */
export type CollectionColumnsMenuColumn = CollectionColumnDeclaration &
  Readonly<{
    /** What it shows, with its window ("Per second, with the last 24 h"). */
    description?: string;
    /** The group a hidden column waits in ("Telemetry"); omitted: built in. */
    source?: string;
  }>;

/**
 * The fields of a Collection anatomy as Columns menu entries, after its primary (title) column: the same keys the
 * Collection draws, so the menu and the table never disagree about a column.
 */
export function collectionColumnsMenuColumns(
  primary: Readonly<{ id: string; title: string }>,
  fields: readonly Readonly<{
    key: string;
    title: string;
    description?: string;
    source?: string;
    defaultHidden?: boolean;
  }>[],
): readonly CollectionColumnsMenuColumn[] {
  return [
    { id: primary.id, title: primary.title, primary: true },
    ...fields.map((field) => ({
      id: field.key,
      title: field.title,
      ...(field.defaultHidden === true ? { defaultHidden: true } : {}),
      ...(field.description === undefined
        ? {}
        : { description: field.description }),
      ...(field.source === undefined ? {} : { source: field.source }),
    })),
  ];
}

const PAGE_HEADER_CONTROL: HeaderControlMetrics = Object.freeze({
  sizePx: HAPPIER_ICON_BUTTON_SIZE,
  glyphPx: ICON_SIZE.sm,
});

/** The trigger stands at the page head's trailing edge, so the menu hangs from that edge and grows inward. */
const TRAILING_EDGE_PORTAL = {
  ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  anchorAlign: 'end',
} as const;

/**
 * A wide table's "⋯" in its page head, opening the one Columns menu (D35, UI refinements 11-17): the person shows,
 * hides and orders the table's columns; the choice is an Account preference read and written through the
 * collection column owner (`useCollectionColumns`). A phone draws no columns, so its pages leave this out.
 */
export function CollectionColumnsMenuButton(
  props: Readonly<{
    collectionId: string;
    columns: readonly CollectionColumnsMenuColumn[];
    /** The shown columns the table's width admits now (`Collection` `onColumnsFit`); omitted: all of them. */
    fittedIds?: readonly string[] | null;
    testID: string;
  }>,
) {
  const controller = useCollectionColumns(props.collectionId, props.columns);
  const scope = usePlacementDragScope();
  const reorder = React.useMemo(
    () =>
      buildCollectionColumnReorderBinding({
        collectionId: props.collectionId,
        scope,
        controller,
      }),
    [controller, props.collectionId, scope],
  );
  return (
    <CollectionColumnsMenuTrigger testID={props.testID}>
      <CollectionColumnsMenuView
        columns={props.columns}
        controller={controller}
        reorder={reorder}
        fittedIds={props.fittedIds ?? null}
        testID={props.testID}
      />
    </CollectionColumnsMenuTrigger>
  );
}

/** The page head's "⋯" and its anchored popover; the menu body is the child. */
export function CollectionColumnsMenuTrigger(
  props: Readonly<{
    testID: string;
    children: React.ReactNode;
    initiallyOpen?: boolean;
  }>,
) {
  const [open, setOpen] = React.useState(props.initiallyOpen === true);
  const anchorRef = React.useRef<View>(null);
  const control = useHeaderControlMetrics(PAGE_HEADER_CONTROL);
  const label = t('collectionColumns.title');
  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <IconButton
          testID={props.testID}
          iconName="dots-three"
          variant="plain"
          size={control.sizePx}
          iconSize={control.glyphPx}
          accessibilityLabel={label}
          tooltip={label}
          tooltipHidden={open}
          expanded={open}
          hasPopup="menu"
          selected={open}
          onPress={() => setOpen((current) => !current)}
        />
      </View>
      {open ? (
        <Popover
          open
          anchorRef={anchorRef}
          placement="bottom"
          gap={6}
          onRequestClose={() => setOpen(false)}
          backdrop={{ enabled: false }}
          portal={TRAILING_EDGE_PORTAL}
          accessibilityLabel={label}
        >
          {({ maxHeight }) => (
            <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
              {props.children}
            </FloatingOverlay>
          )}
        </Popover>
      ) : null}
    </>
  );
}

/**
 * The Columns menu (lab p8Columns menuB, UI refinements' LAB-P8 review): "Shown" lists the drawn columns in table
 * order, the primary column first and fixed, the others with their grip and check; the hidden columns wait below,
 * grouped by where they come from; "Reset to default" ends it, quiet while nothing differs from the default.
 * Pressing a row shows or hides its column; dragging a grip reorders the shown ones.
 */
export function CollectionColumnsMenuView(
  props: Readonly<{
    columns: readonly CollectionColumnsMenuColumn[];
    controller: Pick<
      CollectionColumnsController,
      'ordered' | 'visibleIds' | 'setVisible' | 'reset'
    >;
    reorder: EntityFlatReorderBinding;
    /** The shown columns the width admits; a shown column outside it says it is hidden for want of room. */
    fittedIds: readonly string[] | null;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const fitted = React.useMemo(() => (props.fittedIds === null ? null : new Set(props.fittedIds)), [props.fittedIds]);
  const { columns, controller, testID } = props;
  const byId = React.useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns],
  );
  const visible = React.useMemo(
    () => new Set(controller.visibleIds),
    [controller.visibleIds],
  );
  const defaults = React.useMemo(
    () => resolveCollectionColumns(columns).visibleIds,
    [columns],
  );
  const atDefault =
    defaults.length === controller.visibleIds.length &&
    defaults.every((id, index) => controller.visibleIds[index] === id);
  const ordered = controller.ordered.flatMap((column) => {
    const entry = byId.get(column.id);
    return entry === undefined ? [] : [entry];
  });
  const primary = ordered.find((column) => column.primary === true) ?? null;
  const shown = ordered.filter(
    (column) => column.primary !== true && visible.has(column.id),
  );
  const hidden = ordered.filter(
    (column) => column.primary !== true && !visible.has(column.id),
  );
  // Built-in columns wait first, then each source in the order its columns are declared.
  const builtIn = t('collectionColumns.builtIn');
  const hiddenGroups: {
    title: string;
    columns: CollectionColumnsMenuColumn[];
  }[] = [];
  for (const column of [
    ...hidden.filter((entry) => entry.source === undefined),
    ...hidden.filter((entry) => entry.source !== undefined),
  ]) {
    const title = column.source ?? builtIn;
    const group = hiddenGroups.find((entry) => entry.title === title);
    if (group) group.columns.push(column);
    else hiddenGroups.push({ title, columns: [column] });
  }
  const toggle = (column: CollectionColumnsMenuColumn) => {
    void controller.setVisible(column.id, !visible.has(column.id));
  };
  // A hidden row keeps the grip's place, so every title in the menu starts on one edge.
  const gripSlot = <View style={GRIP_SLOT_STYLE} />;
  const row = (column: CollectionColumnsMenuColumn): ActionListItem => ({
    id: column.id,
    testID: `${testID}.column:${column.id}`,
    label: column.title,
    // The choice stands; the width decides. Widening the page brings it back.
    ...(visible.has(column.id) && fitted !== null && !fitted.has(column.id)
      ? { subtitle: t('collectionColumns.tooNarrow') }
      : column.description === undefined
        ? {}
        : { subtitle: column.description }),
    checked: visible.has(column.id),
    onPress: () => toggle(column),
    icon: gripSlot,
  });
  const shownRows: ActionListItem[] = [
    ...(primary === null
      ? []
      : [
          {
            id: primary.id,
            testID: `${testID}.column:${primary.id}`,
            label: primary.title,
            subtitle: t('collectionColumns.alwaysFirst'),
            icon: gripSlot,
            right: (
              <Icon
                name="lock"
                size={ICON_SIZE.xs}
                color={theme.colors.text.tertiary}
              />
            ),
            accessibilityLabel: `${primary.title}, ${t('collectionColumns.alwaysFirst')}`,
          },
        ]),
    ...shown.map((column): ActionListItem => ({
      ...row(column),
      renderItem: (item, renderDefaultItem) => (
        <EntityFlatReorderRow id={column.id}>
          {({ renderHandle }) =>
            renderDefaultItem({
              ...item,
              icon: renderHandle(`${testID}.move:${column.id}`) ?? gripSlot,
            })
          }
        </EntityFlatReorderRow>
      ),
    })),
  ];
  return (
    <View testID={`${testID}.menu`} style={MENU_STYLE}>
      {/* The menu names what it arranges, on the rows' text edge (lab p8Columns menu). */}
      <Text variant="label" emphasis="semiBold" style={HEADING_STYLE} accessibilityRole="header">
        {t('collectionColumns.title')}
      </Text>
      <EntityFlatReorderList
        binding={props.reorder}
        testID={`${testID}.reorder`}
        alwaysOrganizing
      >
        <ActionListSection
          title={t('navigationPlacement.shown')}
          actions={shownRows}
        />
      </EntityFlatReorderList>
      {hiddenGroups.map((group) => (
        <ActionListSection
          key={group.title}
          title={group.title}
          actions={group.columns.map(row)}
        />
      ))}
      <ActionListSection
        separatorAbove
        actions={[
          {
            id: 'reset',
            testID: `${testID}.reset`,
            label: t('collectionColumns.reset'),
            disabled: atDefault,
            onPress: () => {
              void controller.reset();
            },
          },
        ]}
      />
    </View>
  );
}

/** The person's drag scope (this Home and Account), as the navigation customizer derives it. */
function usePlacementDragScope() {
  const profile = useProfile();
  const home = useActiveServerSnapshot();
  return React.useMemo(
    () =>
      home.serverId && profile.id
        ? { serverId: home.serverId, accountId: profile.id }
        : null,
    [home.serverId, profile.id],
  );
}

const HEADING_STYLE = {
  paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
  paddingTop: MENU_ROW_METRICS.paddingVerticalPx + MENU_ROW_METRICS.sectionPaddingVerticalPx,
} as const;
const GRIP_SLOT_STYLE = { width: ICON_SIZE.md, height: ICON_SIZE.md } as const;
/** Wide enough for a column's name and the line that says what it shows, on one line each. */
const MENU_STYLE = { width: 320, maxWidth: '100%' } as const;

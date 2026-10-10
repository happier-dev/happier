import * as React from 'react';
import { View } from 'react-native';
import {
  getWidgetSizeFootprintV1,
  resolveWidgetGroupWidthFitV1,
  type WidgetSurfaceRefV1,
  type WidgetGroupWidthV1,
  type WidgetLayoutGroupV1,
  type WidgetLayoutItemV1,
  type WidgetSizeV1,
} from '@happier-dev/protocol/widgets';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

/**
 * A group's own operations on its surface (Home's layout owner, or an area's port). Each is one
 * semantic layout intent; the owner admits it (width fit, nesting) and persists it.
 */
export type WidgetGroupOperations = Readonly<{
  setWidth(groupId: string, width: WidgetGroupWidthV1): void;
  setFrame(groupId: string, frameStyle: 'card' | 'plain'): void;
  setDividers(groupId: string, dividers: 'hairline' | 'none'): void;
  ungroup(groupId: string): void;
  /** Removes the group and every widget in it. */
  remove(groupId: string): void;
  /** Moves a widget into a group (`groupId`) or out of one (`null`, beside it), at `toIndex`. */
  move(instanceId: string, toIndex: number, groupId: string | null): void;
  /** Makes a new untitled group of these widgets, where the first one is. */
  create(instanceIds: readonly string[]): void;
}>;

/** What a widget or a group is called in menus: its own name, else (a group) the names of its widgets. */
export function describeWidgetGroup(
  group: Pick<WidgetLayoutGroupV1, 'title' | 'children'>,
  childTitle: (instanceId: string) => string,
): string {
  return (
    group.title ??
    group.children.map((child) => childTitle(child.instance.id)).join(' · ')
  );
}

/** The widths a group can take, each unavailable one naming the widget that prevents it. */
export function resolveWidgetGroupWidthChoices(
  children: readonly Readonly<{
    instance: Readonly<{ id: string }>;
    size?: WidgetSizeV1;
  }>[],
  childTitle: (instanceId: string) => string,
): ReadonlyArray<
  Readonly<{ width: WidgetGroupWidthV1; unavailableReason?: string }>
> {
  return resolveWidgetGroupWidthFitV1(children).widths.map((choice) => ({
    width: choice.width,
    ...(choice.available || !choice.blockingChildId
      ? {}
      : {
          unavailableReason: t('widgetFrame.groupNeedsFullWidth', {
            widget: childTitle(choice.blockingChildId),
          }),
        }),
  }));
}

/**
 * The sizes a widget cannot take inside its group (a half group holds only half-width widgets),
 * shown unavailable with the reason rather than hidden.
 */
export function resolveWidgetGroupChildSizeLimit(input: Readonly<{
    group: Pick<WidgetLayoutGroupV1, 'width'> | undefined;
    groupName: string;
    surface: WidgetSurfaceRefV1['owner']['kind'];
    sizes: readonly WidgetSizeV1[];
}>): Readonly<{ sizes: readonly WidgetSizeV1[]; reason: string }> | undefined {
    if (input.group?.width !== 'half') return undefined;
    const sizes = input.sizes.filter(size => (getWidgetSizeFootprintV1(input.surface, size)?.columnSpan ?? 1) > 1);
    return sizes.length ? { sizes, reason: t('widgetFrame.groupCannotTake', { group: input.groupName }) } : undefined;
}

/** The one mark for a widget group, wherever a group is named: menus, Customize, the Add list. */
export const WIDGET_GROUP_ICON: IconName = 'layout';
/** Ungroup is a verb, not the group: its widgets step apart. */
export const WIDGET_UNGROUP_ICON: IconName = 'exclude-square';

const OPTIONS_SECTION = 'groupOptions';

export type WidgetGroupMenuInput = Readonly<{
  group: WidgetLayoutGroupV1;
  childTitle: (instanceId: string) => string;
  operations: WidgetGroupOperations;
  /** Inputs…, repeating the group's value; absent when no child can follow it. */
  editInputs:
    | Readonly<{ onPress: () => void; binding: string | null }>
    | undefined;
  onRename: (() => void) | undefined;
  /** Save group… (a private copy in Your widgets); absent where it cannot succeed. */
  onSave: (() => void) | undefined;
  /** Add to… (a copy on another Home or Project); absent where there is nowhere to copy it. */
  onAddTo: (() => void) | undefined;
  /** Phones have one column: everything is full width there, so Width is not offered. */
  showWidth: boolean;
}>;

/**
 * A group's ⋯ (lab `widget-groups` wgmenu M), in the widget menu's order: Inputs… and Rename, then
 * how it sits (Width, Frame, Dividers), then Save group…, then Ungroup and, last, the explicit
 * "Remove group and its widgets". The option rows are real choices (fallback rows with the selection)
 * and the open menu draws them as segmented rows (`renderWidgetGroupMenuSection`).
 */
export function buildWidgetGroupActions(
  input: WidgetGroupMenuInput,
): ItemAction[] {
  const { group, operations } = input;
  // Untitled sections are set off by hairlines (lab wgmenu M): how it sits, keeping it, letting it go.
  // The menu is anchored to its group, so no section repeats the group's name (lab wgmenu M).
  const identity = { id: 'groupIdentity', title: '' };
  const options = { id: OPTIONS_SECTION, title: '' };
  const keep = { id: 'groupKeep', title: '' };
  const end = { id: 'groupEnd', title: '' };
  const widths = input.showWidth
    ? resolveWidgetGroupWidthChoices(group.children, input.childTitle)
    : [];
  return [
    ...(input.editInputs
      ? [
          {
            id: 'groupInputs',
            title: t('widgetFrame.groupInputs'),
            icon: 'sliders-horizontal' as const,
            group: identity,
            ...(input.editInputs.binding
              ? { subtitle: input.editInputs.binding }
              : {}),
            onPress: input.editInputs.onPress,
          },
        ]
      : []),
    ...(input.onRename
      ? [
          {
            id: 'rename',
            title: t('common.rename'),
            icon: 'text-aa' as const,
            group: identity,
            onPress: input.onRename,
          },
        ]
      : []),
    ...widths.map((choice) => ({
      id: `width-${choice.width}`,
      title: t(
        choice.width === 'half'
          ? 'widgetFrame.widthHalf'
          : 'widgetFrame.widthFull',
      ),
      icon: 'arrows-left-right' as const,
      selected: group.width === choice.width,
      group: options,
      ...(choice.unavailableReason
        ? { subtitle: choice.unavailableReason, disabled: true }
        : {}),
      onPress: () => {
        if (group.width !== choice.width)
          operations.setWidth(group.id, choice.width);
      },
    })),
    ...(['card', 'plain'] as const).map((style) => ({
      id: `frame-${style}`,
      title: t(
        style === 'card' ? 'widgetFrame.styleCard' : 'widgetFrame.stylePlain',
      ),
      icon: 'square' as const,
      selected: group.frameStyle === style,
      group: options,
      onPress: () => {
        if (group.frameStyle !== style) operations.setFrame(group.id, style);
      },
    })),
    ...(['hairline', 'none'] as const).map((dividers) => ({
      id: `dividers-${dividers}`,
      title: t(
        dividers === 'hairline'
          ? 'widgetFrame.dividersLines'
          : 'widgetFrame.dividersNone',
      ),
      icon: 'minus' as const,
      selected: group.dividers === dividers,
      group: options,
      onPress: () => {
        if (group.dividers !== dividers)
          operations.setDividers(group.id, dividers);
      },
    })),
    ...(input.onSave
      ? [
          {
            id: 'saveGroup',
            title: t('widgetFrame.groupSave'),
            subtitle: t('widgetFrame.groupSaveSubtitle'),
            icon: 'floppy-disk' as const,
            group: keep,
            onPress: input.onSave,
          },
        ]
      : []),
    ...(input.onAddTo
      ? [
          {
            id: 'addTo',
            title: t('widgetFrame.groupAddTo'),
            subtitle: t('widgetFrame.groupAddToSubtitle'),
            icon: 'copy' as const,
            group: keep,
            onPress: input.onAddTo,
          },
        ]
      : []),
    {
      id: 'ungroup',
      title: t('widgetFrame.ungroup'),
      subtitle: t('widgetFrame.ungroupSubtitle', {
        count: group.children.length,
      }),
      icon: WIDGET_UNGROUP_ICON,
      group: end,
      onPress: () => operations.ungroup(group.id),
    },
    {
      id: 'removeGroup',
      title: t('widgetFrame.groupRemove'),
      icon: 'trash' as const,
      destructive: true,
      group: end,
      onPress: () => operations.remove(group.id),
    },
  ];
}

/** The open menu's option rows: Width (unavailable widths say why), Frame and Dividers, each segmented. */
export function renderWidgetGroupMenuSection(
  input: WidgetGroupMenuInput,
  sectionId: string,
  testID: string,
): React.ReactNode | undefined {
  if (sectionId !== OPTIONS_SECTION) return undefined;
  return <WidgetGroupOptionRows {...input} testID={testID} inMenu />;
}

/** Width, Frame and Dividers as segmented rows: the group ⋯ and the Customize bar draw these same rows. */
export function WidgetGroupOptionRows(
  props: WidgetGroupMenuInput & Readonly<{ testID: string; only?: 'width'; /** Drawn as menu rows (the group ⋯). */ inMenu?: boolean }>,
) {
  const { group, operations } = props;
  const widths = props.showWidth
    ? resolveWidgetGroupWidthChoices(group.children, props.childTitle)
    : [];
  return (
    <View>
      {widths.length ? (
        <SegmentedChoiceItem<WidgetGroupWidthV1>
          rowRole={props.inMenu ? 'menu' : undefined}
          testIDPrefix={`${props.testID}.width`}
          title={t('widgetFrame.groupWidth')}
          icon={<Icon name="arrows-left-right" />}
          value={group.width}
          options={widths.map((choice) => ({
            id: choice.width,
            label: t(
              choice.width === 'half'
                ? 'widgetFrame.widthHalf'
                : 'widgetFrame.widthFull',
            ),
            ...(choice.unavailableReason
              ? { unavailableReason: choice.unavailableReason }
              : {}),
          }))}
          onChange={(width) => operations.setWidth(group.id, width)}
          showDivider={false}
        />
      ) : null}
      {props.only === 'width' ? null : (
        <>
          <SegmentedChoiceItem<'card' | 'plain'>
          rowRole={props.inMenu ? 'menu' : undefined}
            testIDPrefix={`${props.testID}.frame`}
            title={t('widgetFrame.groupFrame')}
            icon={<Icon name="square" />}
            value={group.frameStyle}
            options={[
              { id: 'card', label: t('widgetFrame.styleCard') },
              { id: 'plain', label: t('widgetFrame.stylePlain') },
            ]}
            onChange={(frameStyle) => operations.setFrame(group.id, frameStyle)}
            showDivider={false}
          />
          <SegmentedChoiceItem<'hairline' | 'none'>
          rowRole={props.inMenu ? 'menu' : undefined}
            testIDPrefix={`${props.testID}.dividers`}
            title={t('widgetFrame.groupDividers')}
            icon={<Icon name="minus" />}
            value={group.dividers}
            options={[
              { id: 'hairline', label: t('widgetFrame.dividersLines') },
              { id: 'none', label: t('widgetFrame.dividersNone') },
            ]}
            onChange={(dividers) => operations.setDividers(group.id, dividers)}
            showDivider={false}
          />
        </>
      )}
    </View>
  );
}

/**
 * A widget's group entries in its own ⋯ (lab wgmenu C/G). Inside a group: Move to group (the other
 * groups, with their width and size; one that cannot take it says why), Remove from group (back on
 * its own card, beside the group) and Ungroup. Standalone: Group with… its neighbours (a new untitled
 * group) or a group that can take it. A widget menu inside a group never offers its own frame.
 */
export function buildWidgetGroupMembershipActions(
  input: Readonly<{
    instanceId: string;
    size: WidgetSizeV1 | undefined;
    items: readonly WidgetLayoutItemV1[];
    childTitle: (instanceId: string) => string;
    operations: WidgetGroupOperations;
  }>,
): ItemAction[] {
  const { items, instanceId, operations } = input;
  const parent = items.find(
    (item): item is WidgetLayoutGroupV1 =>
      item.kind === 'group' &&
      item.children.some((child) => child.instance.id === instanceId),
  );
  const groups = items.filter(
    (item): item is WidgetLayoutGroupV1 =>
      item.kind === 'group' && item !== parent,
  );
  const name = (group: WidgetLayoutGroupV1) =>
    describeWidgetGroup(group, input.childTitle);
  const into = (
    group: WidgetLayoutGroupV1,
    section: ItemAction['group'],
  ): ItemAction => {
    const fit = resolveWidgetGroupWidthFitV1([
      ...group.children,
      {
        instance: { id: instanceId },
        ...(input.size ? { size: input.size } : {}),
      },
    ]);
    const fits = fit.availableWidths.includes(group.width);
    return {
      id: `${parent ? 'moveToGroup' : 'groupWith'}-${group.id}`,
      title: name(group),
      icon: WIDGET_GROUP_ICON,
      group: section,
      subtitle: fits
        ? t('widgetFrame.groupFacts', {
            width: t(
              group.width === 'half'
                ? 'widgetFrame.widthHalf'
                : 'widgetFrame.widthFull',
            ),
            count: group.children.length,
          })
        : t('widgetFrame.groupCannotTake', { group: name(group) }),
      ...(fits ? {} : { disabled: true }),
      onPress: () =>
        operations.move(instanceId, group.children.length, group.id),
    };
  };
  if (parent) {
    const section = { id: 'moveToGroup', title: t('widgetFrame.moveToGroup') };
    const at = items.indexOf(parent);
    return [
      ...groups.map((group) => into(group, section)),
      {
        id: 'removeFromGroup',
        title: t('widgetFrame.removeFromGroup'),
        subtitle: t('widgetFrame.removeFromGroupSubtitle'),
        icon: 'arrow-square-out',
        onPress: () => operations.move(instanceId, at + 1, null),
      },
      {
        id: 'ungroup',
        title: t('widgetFrame.ungroup'),
        subtitle: t('widgetFrame.ungroupSubtitle', {
          count: parent.children.length,
        }),
        icon: WIDGET_UNGROUP_ICON,
        onPress: () => operations.ungroup(parent.id),
      },
    ];
  }
  const section = { id: 'groupWith', title: t('widgetFrame.groupWith') };
  const at = items.findIndex(
    (item) => item.kind === 'widget' && item.instance.id === instanceId,
  );
  const neighbours = [items[at - 1], items[at + 1]].filter(
    (item): item is Extract<WidgetLayoutItemV1, { kind: 'widget' }> =>
      item?.kind === 'widget',
  );
  return [
    ...neighbours.map((neighbour): ItemAction => ({
      id: `groupWith-${neighbour.instance.id}`,
      title: input.childTitle(neighbour.instance.id),
      icon: WIDGET_GROUP_ICON,
      group: section,
      subtitle: t('widgetFrame.groupWithNew'),
      onPress: () =>
        operations.create(
          items.indexOf(neighbour) < at
            ? [neighbour.instance.id, instanceId]
            : [instanceId, neighbour.instance.id],
        ),
    })),
    ...groups.map((group) => into(group, section)),
  ];
}

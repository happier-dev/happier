import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type {
  EntityDropEffectV1,
  EntityDropPreviewV1,
  PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import {
  WidgetInstanceActionInputSchemasV1,
  getWidgetLayoutItemIdV1,
  type WidgetLayoutGroupV1,
  type WidgetLayoutItemV1,
  type WidgetProjectAreaV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import type { SessionSurfaceEntityBinding } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { resolveEntityFlatRowPosition } from '@/components/ui/treeDragDrop/geometry/entityFlatListStrategy';
import type {
  WindowBounds,
  WindowPointer,
} from '@/components/ui/treeDragDrop/treeDragDropTypes';
import { resolveWidgetLayoutEntityDrop } from '@/components/ui/treeDragDrop/widgetLayoutEntityDrop';
import { widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { t } from '@/text';

/** Every widget source a layout can take; a whole group is accepted (and refused inside a group: no nesting). */
const LAYOUT_ACCEPTED_KINDS = [
  'home-section',
  'widget-area-instance',
  'work-board-widget',
  'session-board-item',
  'companion-item',
  'widget-layout-group',
] as const;

/** The band at a group's top and bottom where a drop goes beside it rather than into it. */
const GROUP_EDGE_SHARE = 0.25;

type Target = NonNullable<SessionSurfaceEntityBinding['target']>;
type Shared = Readonly<{
  surface: WidgetSurfaceRefV1;
  items: readonly WidgetLayoutItemV1[];
  topLevelIds?: readonly string[];
  area?: WidgetProjectAreaV1 | undefined;
  canEdit?: boolean;
  /** The carried widget's placement on its own surface (for a group's width admission). */
  sourceItem?: WidgetLayoutItemV1 | undefined;
  /** What the host calls a group, so the preview names an untitled one by its widgets. */
  describeGroup?: ((group: WidgetLayoutGroupV1) => string) | undefined;
}>;

function layoutTarget(
  input: Shared &
    Readonly<{
      fallback: PluginUiJsonValueV1;
      preview: EntityDropPreviewV1;
      destinations: Target['listDestinations'];
    }>,
): Target {
  return {
    acceptedKinds: [...LAYOUT_ACCEPTED_KINDS],
    listDestinations: input.destinations,
    resolve: ({ item, destination }) => {
      const admission = resolveWidgetLayoutEntityDrop({
        item,
        surface: input.surface,
        items: input.items,
        topLevelIds: input.topLevelIds,
        canEdit: input.canEdit ?? true,
        destination: destination ?? input.fallback,
        preview: input.preview,
        ...(input.area ? { area: input.area } : {}),
        ...(input.sourceItem ? { sourceItem: input.sourceItem } : {}),
        ...(input.describeGroup ? { describeGroup: input.describeGroup } : {}),
      });
      return admission.status === 'refused'
        ? widgetMovementRefused(admission.reason.code, admission.preview)
        : admission;
    },
    // The shared surface binding executes the admitted `widgets.item.move` itself.
    execute: async () => ({
      status: 'refused',
      reason: {
        code: 'unsupported_widget_surface',
        message: t('entityDragDrop.surface.widgetMoveUnavailable'),
      },
    }),
  };
}

/**
 * A group as a drop target (lab wgdnd B): into it (the group is outlined), or beside it at its top or
 * bottom edge (the line). The shared entity owner admits each — width fit, no groups inside groups —
 * and a refusal lights nothing, leaving the release preview to say why and what to do instead.
 */
export function widgetGroupDropTarget(
  input: Shared & Readonly<{ group: WidgetLayoutGroupV1; name: string }>,
): Target {
  const into = {
    anchorId: null,
    placement: 'after' as const,
    groupId: input.group.id,
  };
  return layoutTarget({
    ...input,
    fallback: into,
    describeGroup: input.describeGroup ?? ((group) => group.id === input.group.id ? input.name : group.title ?? t('widgetFrame.groupUntitled')),
    preview: { verb: t('widgetFrame.moveIntoGroupNamed', { group: input.name }), target: input.name },
    destinations: () => [
      {
        destination: into,
        label: input.name,
        group: t('widgetFrame.moveToGroup'),
      },
      ...(['before', 'after'] as const).map((placement) => ({
        destination: { anchorId: input.group.id, placement },
        label: t(
          placement === 'before'
            ? 'entityDragDrop.preview.moveAbove'
            : 'entityDragDrop.preview.moveBelow',
          { target: input.name },
        ),
      })),
    ],
  });
}

/**
 * Whether an admitted effect would put the carried widget INTO this group from outside it (lab wgdnd 1):
 * the group is then outlined, wherever inside it the pointer is. A reorder inside changes no container.
 */
export function widgetGroupTakesEffect(
  group: WidgetLayoutGroupV1,
  surface: WidgetSurfaceRefV1,
  effect: EntityDropEffectV1,
): boolean {
  if (effect.actionId !== 'widgets.item.move') return false;
  const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
  if (!move.success || !('to' in move.data)) return false;
  const { ref, to } = move.data;
  if (to.groupId !== group.id || !sameStrictJsonValue(to.surface, surface)) return false;
  return !(
    sameStrictJsonValue(ref.surface, surface) &&
    group.children.some((child) => child.instance.id === ref.instanceId)
  );
}

/** Where a pointer over a group drops: beside it near its top or bottom edge, into it elsewhere. */
export function resolveWidgetGroupPointerDestination(
  groupId: string,
  bounds: WindowBounds,
  pointer: WindowPointer,
): PluginUiJsonValueV1 {
  const offset = (pointer.y - bounds.y) / Math.max(1, bounds.height);
  if (offset < GROUP_EDGE_SHARE)
    return { anchorId: groupId, placement: 'before' };
  if (offset > 1 - GROUP_EDGE_SHARE)
    return { anchorId: groupId, placement: 'after' };
  return { anchorId: null, placement: 'after', groupId };
}

/**
 * One widget card as a drop target: the line above or below it. Inside a group the line reorders
 * within that group (the destination carries its `groupId`); otherwise it places beside the card.
 */
export function widgetLayoutCardDropTarget(
  input: Shared &
    Readonly<{
      itemId: string;
      title: string;
      groupId?: string | undefined;
      groupLabel: string;
    }>,
): Target {
  const at = (placement: 'before' | 'after') => ({
    anchorId: input.itemId,
    placement,
    ...(input.groupId ? { groupId: input.groupId } : {}),
  });
  return layoutTarget({
    ...input,
    fallback: at('after'),
    preview: { verb: t('entityDragDrop.organize.title'), target: input.title },
    destinations: () =>
      (['before', 'after'] as const).map((placement) => ({
        destination: at(placement),
        label: t(
          placement === 'before'
            ? 'entityDragDrop.preview.moveAbove'
            : 'entityDragDrop.preview.moveBelow',
          { target: input.title },
        ),
        group: input.groupLabel,
      })),
  });
}

/** The card's pointer destination: the nearer edge, inside its group when it has one. */
export function resolveWidgetCardPointerDestination(
  itemId: string,
  groupId: string | undefined,
  bounds: WindowBounds,
  pointer: WindowPointer,
): PluginUiJsonValueV1 {
  return {
    ...resolveEntityFlatRowPosition(itemId, bounds, pointer),
    ...(groupId ? { groupId } : {}),
  };
}

/**
 * The one "new row" target that ends a customized page (lab wgmenu E): whatever is dropped there goes
 * to the end of the layout's top level, out of any group, through the same resolver as every other
 * place. It is one destination, so a pointer anywhere on it means the same thing.
 */
export function widgetLayoutEndDropTarget(
  input: Shared & Readonly<{ verb: string; label: string; groupLabel: string }>,
): Target {
  const end = { anchorId: null, placement: 'after' as const, groupId: null };
  return layoutTarget({
    ...input,
    fallback: end,
    preview: { verb: input.verb, target: input.groupLabel },
    destinations: () => [
      { destination: end, label: input.label, group: input.groupLabel },
    ],
  });
}

/** The ids the card's line is measured against: its group's widgets, or the layout's top-level items. */
export function widgetLayoutSiblingIds(
  items: readonly WidgetLayoutItemV1[],
  groupId: string | undefined,
  topLevelIds?: readonly string[],
): readonly string[] {
  const group = groupId
    ? items.find(
        (item): item is WidgetLayoutGroupV1 =>
          item.kind === 'group' && item.id === groupId,
      )
    : undefined;
  return group
    ? group.children.map((child) => child.instance.id)
    : topLevelIds ?? items.map(getWidgetLayoutItemIdV1);
}

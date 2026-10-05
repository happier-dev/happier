import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, sameStrictJsonValue } from '@happier-dev/protocol';
import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDropAdmissionV1, type EntityDropPreviewV1 } from '@happier-dev/protocol/plugins/ui';
import type { WidgetAreaLayoutV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { widgetEntitySourceRef, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';

/** Current semantic anchors become a request to the incumbent widget movement owner, never a layout write. */
export function resolveWidgetAreaEntityDrop(input: Readonly<{
    item: EntityDragItemV1;
    surface: WidgetSurfaceRefV1;
    placements: WidgetAreaLayoutV1['instances'];
    canEdit: boolean;
    destination: unknown;
    preview: EntityDropPreviewV1;
}>): EntityDropAdmissionV1 {
    const ref = widgetEntitySourceRef(input.item);
    if (!ref) return widgetMovementRefused('unsupported_widget_surface', input.preview);
    if (!entityDragScopesEqualV1(input.item.scope, input.surface)) return widgetMovementRefused('scope-mismatch', input.preview);
    if (!input.canEdit) return widgetMovementRefused('widget_edit_denied', input.preview);
    const parsed = AnchoredListPositionV1Schema.safeParse(input.destination ?? { anchorId: null, placement: 'after' });
    if (!parsed.success) return widgetMovementRefused('anchor-gone', input.preview);
    const position = parsed.data;
    const ids = input.placements.map(entry => entry.instance.id);
    const sameArea = sameStrictJsonValue(ref.surface, input.surface);
    let index: number;
    if (sameArea) {
        const order = resolveAnchoredListMoveV1(ids, ref.instanceId, position);
        if (!order) return widgetMovementRefused('widget_instance_not_found', input.preview);
        index = order.indexOf(ref.instanceId);
        if (index === ids.indexOf(ref.instanceId)) return widgetMovementRefused('same-position', input.preview);
    } else {
        if (ids.includes(ref.instanceId)) return widgetMovementRefused('widget_instance_already_exists', input.preview);
        const anchor = position.anchorId === null ? null : ids.indexOf(position.anchorId);
        if (anchor === -1) return widgetMovementRefused('anchor-gone', input.preview);
        index = anchor === null ? position.placement === 'before' ? 0 : ids.length : anchor + (position.placement === 'after' ? 1 : 0);
    }
    return { status: 'allowed', effect: { actionId: 'widgets.instance.move', input: { ref, to: { surface: input.surface, index } }, preview: input.preview } };
}

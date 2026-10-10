import type { EntityDragItemV1, EntityDropAdmissionV1, EntityDropPreviewV1 } from '@happier-dev/protocol/plugins/ui';
import type { WidgetPlacementV1, WidgetLayoutGroupV1, WidgetLayoutItemV1, WidgetSurfaceRefV1, WidgetProjectAreaV1 } from '@happier-dev/protocol/widgets';
import { resolveWidgetLayoutEntityDrop } from '@/components/ui/treeDragDrop/widgetLayoutEntityDrop';
import { widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';

/** Area presentation delegates item/container admission to the shared entity owner. */
export function resolveWidgetAreaEntityDrop(input: Readonly<{
    item: EntityDragItemV1;
    surface: WidgetSurfaceRefV1;
    placements: readonly (WidgetLayoutItemV1 | WidgetPlacementV1)[];
    sourceItem?: WidgetLayoutItemV1;
    canEdit: boolean;
    area?: WidgetProjectAreaV1;
    destination: unknown;
    preview: EntityDropPreviewV1;
    describeGroup?: (group: WidgetLayoutGroupV1) => string;
}>): EntityDropAdmissionV1 {
    const items = input.placements.map((entry): WidgetLayoutItemV1 => 'kind' in entry ? entry : { kind: 'widget', ...entry });
    const admission = resolveWidgetLayoutEntityDrop({ ...input, items });
    return admission.status === 'refused' ? widgetMovementRefused(admission.reason.code, admission.preview) : admission;
}

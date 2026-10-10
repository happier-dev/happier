import * as React from 'react';
import { HAPPIER_WIDGET_FRAME_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';
import type { WidgetLayoutGroupV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import {
    SessionSurfaceEntityContainerFeedback,
    type SessionSurfaceEntityDrag,
} from '@/components/sessions/board/SessionSurfaceEntityDrag';

import { widgetGroupTakesEffect } from './widgetGroupDropTarget';

/**
 * A group's drop feedback on every host (lab widget-groups wgdnd): the outline over its card while a
 * widget would enter it, the line at its edge while one would land beside it. The shared entity owner
 * admits the drop; this only reads its verdict.
 */
export function WidgetGroupDropFeedback(
    props: Readonly<{
        drag: SessionSurfaceEntityDrag;
        group: WidgetLayoutGroupV1;
        surface: WidgetSurfaceRefV1;
        testID: string;
    }>,
) {
    const { group, surface } = props;
    const enters = React.useCallback(
        (effect: EntityDropEffectV1) => widgetGroupTakesEffect(group, surface, effect),
        [group, surface],
    );
    return (
        <SessionSurfaceEntityContainerFeedback
            drag={props.drag}
            radius={HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx}
            enters={enters}
            testID={props.testID}
        />
    );
}

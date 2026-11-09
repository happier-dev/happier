import * as React from 'react';
import { PluginUiWidgetAreaResultV1Schema, type PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginUiWidgetAreaPortV1 } from '@happier-dev/plugin-ui/hostApi';

import { PluginPageWidgetArea } from '@/components/widgets/area/PluginPageWidgetArea';

import type { BoundPluginSurfaceController } from './boundPluginSurfaceController';

/** The mounted page's area facade and the name its Add says ("Add to PRs & Issues"). */
export type DeclarativeWidgetAreaBinding = Readonly<{
    dispatch: NonNullable<BoundPluginSurfaceController['widgetArea']>;
    surfaceName: string;
    /** The declarative host's same readiness facts; it has no native PluginUiProvider. */
    machineConnectionPending?: boolean;
    machineExecutionReady?: boolean;
}>;

/** What the declarative renderer calls for one `widgetArea` node. */
export type DeclarativeWidgetAreaRender = (input: Readonly<{ area: string; context: Readonly<Record<string, unknown>>;
    title?: string; description?: string; testID: string }>) => React.ReactNode;

/** The renderer bridge for one mount: each node becomes the same area owner over this mount's facade. */
export function createDeclarativeWidgetAreaRender(binding: DeclarativeWidgetAreaBinding): DeclarativeWidgetAreaRender {
    return (input) => <DeclarativeWidgetArea {...input} binding={binding} />;
}

const UNAVAILABLE: PluginUiWidgetAreaResultV1 = { ok: false, errorCode: 'widget_area_unavailable', error: 'widget_area_unavailable' };

/**
 * A declarative page's `widgetArea` node: the same area owner a native page reaches through the
 * public `WidgetSurface`, over this mount's installed area facade. The node supplies only the area
 * name and the page's readable context; the host admits both on every operation.
 */
export function DeclarativeWidgetArea(props: Readonly<{
    area: string;
    context: Readonly<Record<string, unknown>>;
    title?: string;
    description?: string;
    binding: DeclarativeWidgetAreaBinding | null;
    testID: string;
}>): React.ReactElement {
    const dispatch = props.binding?.dispatch ?? null;
    const port = React.useMemo<PluginUiWidgetAreaPortV1>(() => ({
        execute: async (operation, context, options) => {
            if (!dispatch) return UNAVAILABLE;
            const result = PluginUiWidgetAreaResultV1Schema.safeParse(await dispatch({ area: props.area, operation,
                ...(options?.layoutId === undefined ? {} : { layoutId: options.layoutId }), ...(context ? { context } : {}) },
                options?.signal ? { signal: options.signal } : undefined));
            return result.success ? result.data : UNAVAILABLE;
        },
    // A readiness transition changes the read binding even when this mount's dispatch is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [dispatch, props.area, props.binding?.machineConnectionPending, props.binding?.machineExecutionReady]);
    return (
        <PluginPageWidgetArea
            area={props.area}
            context={props.context as Readonly<Record<string, JsonValue>>}
            title={props.title}
            description={props.description}
            port={port}
            surfaceName={props.binding?.surfaceName ?? props.area}
            testID={props.testID}
        />
    );
}

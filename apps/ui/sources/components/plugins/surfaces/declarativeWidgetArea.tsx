import * as React from 'react';
import { PluginUiWidgetAreaResultV1Schema, type PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import type { JsonValue } from '@happier-dev/protocol';
import type { PluginUiWidgetAreaPortV1 } from '@happier-dev/plugin-ui/hostApi';

import { PluginPageWidgetArea } from '@/components/widgets/area/PluginPageWidgetArea';

import type { BoundPluginSurfaceController } from './boundPluginSurfaceController';

/** The mounted page's area facade and the name its Add says ("Add to PRs & Issues"). */
export type DeclarativeWidgetAreaBinding = Readonly<{
    dispatch: NonNullable<BoundPluginSurfaceController['widgetArea']>;
    surfaceName: string;
}>;

/** What the declarative renderer calls for one `widgetArea` node. */
export type DeclarativeWidgetAreaRender = (input: Readonly<{ area: string; context: Readonly<Record<string, unknown>>; testID: string }>) => React.ReactNode;

/** The renderer bridge for one mount: each node becomes the same area owner over this mount's facade. */
export function createDeclarativeWidgetAreaRender(binding: DeclarativeWidgetAreaBinding): DeclarativeWidgetAreaRender {
    return (input) => <DeclarativeWidgetArea area={input.area} context={input.context} binding={binding} testID={input.testID} />;
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
    binding: DeclarativeWidgetAreaBinding | null;
    testID: string;
}>): React.ReactElement {
    const dispatch = props.binding?.dispatch ?? null;
    const port = React.useMemo<PluginUiWidgetAreaPortV1>(() => ({
        execute: async (operation, context, options) => {
            if (!dispatch) return UNAVAILABLE;
            const result = PluginUiWidgetAreaResultV1Schema.safeParse(await dispatch({ area: props.area, operation, ...(context ? { context } : {}) },
                options?.signal ? { signal: options.signal } : undefined));
            return result.success ? result.data : UNAVAILABLE;
        },
    }), [dispatch, props.area]);
    return (
        <PluginPageWidgetArea
            area={props.area}
            context={props.context as Readonly<Record<string, JsonValue>>}
            port={port}
            surfaceName={props.binding?.surfaceName ?? props.area}
            testID={props.testID}
        />
    );
}

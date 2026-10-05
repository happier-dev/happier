import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol';
import type { PluginUiWidgetAreaPresentation } from '@happier-dev/plugin-ui/advanced';

import type { WidgetSurfaceContext, WidgetSurfaceContextSlot } from '@/components/widgets/surface/widgetSurfaceSetup';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { WidgetArea } from './WidgetArea';
import type { WidgetAreaPort } from './useWidgetAreaLayout';

/** A page value as people read it: a string is itself; anything else is its compact JSON. */
function describePageValue(value: JsonValue): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The page's context as the widget owners read it: each declared value is a slot named "This page",
 * so an input with that name follows the page (lab `dashboards` PG: Checks follows the repository
 * the page is filtered by). The values stay whatever the page provides; the area's declared schema
 * admits them on every operation.
 */
export function pluginPageWidgetContext(context: Readonly<Record<string, JsonValue>>): WidgetSurfaceContext {
    const slots: Record<string, WidgetSurfaceContextSlot> = {};
    for (const [slot, value] of Object.entries(context)) {
        slots[slot] = { label: t('widgetAdd.thisPage'), value: { value, label: describePageValue(value) } };
    }
    return { slots };
}

/**
 * A plugin page's declared widget area (`<WidgetSurface area="pinned" />`): the one widget area
 * owner, reached through the mounted Host API port the page lent. Every operation carries the page's
 * current context, so the host admits it against the declared schema before reading or writing.
 */
export function PluginPageWidgetArea(props: PluginUiWidgetAreaPresentation & Readonly<{ surfaceName: string }>): React.ReactElement {
    const contextKey = stableJsonStringify(props.context);
    // Keyed by value, not identity: a page re-rendering with the same filter keeps one binding.
    const pageContext = React.useMemo(() => JSON.parse(contextKey) as Readonly<Record<string, JsonValue>>, [contextKey]);
    const { port: pagePort } = props;
    const port = React.useMemo<WidgetAreaPort>(() => ({
        execute: (operation, signal) => pagePort.execute(operation, pageContext, signal ? { signal } : undefined),
    }), [pageContext, pagePort]);
    const context = React.useMemo(() => pluginPageWidgetContext(pageContext), [pageContext]);
    return (
        <WidgetArea
            port={port}
            context={context}
            geometry="grid"
            title={props.title ?? t('widgetAdd.areaPinned')}
            meta={props.description ?? t('widgetAdd.areaPinnedMeta')}
            surfaceName={props.surfaceName}
            testID={props.testID ?? `widget-area.${props.area}`}
        />
    );
}

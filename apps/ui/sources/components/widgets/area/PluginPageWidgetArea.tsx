import * as React from 'react';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { PluginUiWidgetAreaPresentation } from '@happier-dev/plugin-ui/advanced';

import type { WidgetSurfaceContext, WidgetSurfaceContextSlot } from '@/components/widgets/surface/widgetSurfaceSetup';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { executeWidgetEntityMovement, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
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
    const context = React.useMemo(() => pluginPageWidgetContext(pageContext), [pageContext]);
    const port = React.useMemo<WidgetAreaPort>(() => {
        // The mounted area port admits declaration, context and lifetime and supplies identity.
        // Authored page values never select a Home/Account or a different destination.
        const readMovementContext = async (destination: WidgetSurfaceRefV1, signal?: AbortSignal) => {
            const result = await pagePort.execute({ actionId: 'widgets.item.list' }, pageContext, signal ? { signal } : undefined);
            if (!result.ok) return { ok: false, code: result.errorCode ?? 'widget_area_unavailable' } as const;
            const read = WidgetSurfaceReadV1Schema.safeParse(result.result);
            if (!read.success) return { ok: false, code: 'invalid_widget_area_result' } as const;
            if (!sameStrictJsonValue(read.data.surface, destination)) return { ok: false, code: 'widget_destination_changed' } as const;
            return { ok: true, context: { surface: read.data.surface, values: widgetProvidedContext(context) } } as const;
        };
        return {
            execute: (operation, signal) => pagePort.execute(operation, pageContext, signal ? { signal } : undefined),
            movement: {
                readAdmission: async (ref, destination, signal) => {
                    const admitted = await readMovementContext(destination, signal);
                    if (!admitted.ok) return { status: 'refused', code: admitted.code };
                    const { readDefaultWidgetMovementAdmission } = await import('@/sync/ops/actions/defaultActionExecutor');
                    return readDefaultWidgetMovementAdmission(ref, destination, signal, admitted.context);
                },
                execute: async (effect, scope) => {
                    const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
                    if (!move.success) return widgetMovementRefused('invalid_parameters', effect.preview);
                    const destination = 'to' in move.data ? move.data.to.surface : move.data.ref.surface;
                    const admitted = await readMovementContext(destination);
                    if (!admitted.ok) return widgetMovementRefused(admitted.code, effect.preview);
                    return executeWidgetEntityMovement(effect, scope, admitted.context);
                },
            },
        };
    }, [context, pageContext, pagePort]);
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

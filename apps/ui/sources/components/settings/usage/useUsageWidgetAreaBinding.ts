import * as React from 'react';
import { USAGE_QUERY_INPUT_FIELDS, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';
import { useCorePageWidgetAreaBinding } from '@/components/widgets/area/useCorePageWidgetAreaBinding';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { createUsageWidgetPresets, type UsageWidgetPresetId } from './usageWidgetPresets';

/** Thin host composition; named views, revisions, Reset/Undo and Artifact custody remain platform-owned. */
export function useUsageWidgetAreaBinding(input: Readonly<{
    serverId: string;
    providedContext: WidgetBindingResolutionInputV1['context'];
    names: Readonly<Record<UsageWidgetPresetId, string>>;
    initialMetric?: UsageQuery['metric'];
    labelForSlot?: (path: string) => string;
}>) {
    const presets = React.useMemo(() => createUsageWidgetPresets(input.names, { initialMetric: input.initialMetric }), [input.names, input.initialMetric]);
    const context = React.useMemo((): WidgetSurfaceContext => ({ slots: Object.fromEntries(
        USAGE_QUERY_INPUT_FIELDS.filter(field => field.contextMode === 'follow').map(field => {
            const values = input.providedContext[field.path];
            const label = input.labelForSlot?.(field.path) ?? field.title;
            return [field.path, { label, value: values?.length === 1 ? { value: values[0]!, label } : null }];
        }),
    ) }), [input.providedContext, input.labelForSlot]);
    const binding = useCorePageWidgetAreaBinding({ serverId: input.serverId, pageId: 'usage', area: 'main', presets, context });
    return React.useMemo(() => ({ ...binding, presets }), [binding, presets]);
}

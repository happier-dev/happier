import * as React from 'react';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';
import { useCorePageWidgetAreaBinding } from '@/components/widgets/area/useCorePageWidgetAreaBinding';
import type { UsagePeriod } from '@/sync/api/account/usagePeriods';
import { createUsageSessionWidgetPresets, createUsageWidgetPresets, USAGE_SESSION_WIDGET_AREA, type UsageWidgetPresetId } from './usageWidgetPresets';
import { t } from '@/text';
import { usageWidgetSurfaceContext } from './usageWidgetPageContext';

/** Thin host composition; named views, revisions, Reset/Undo and Artifact custody remain platform-owned. */
export function useUsageWidgetAreaBinding(input: Readonly<{
    serverId: string;
    providedContext: WidgetBindingResolutionInputV1['context'];
    /** Only the admitted Session route declares a Session editor slot. */
    sessionId?: string;
    /** The page's period by name; the provided context carries only its resolved start. */
    period: UsagePeriod;
    names: Readonly<Record<UsageWidgetPresetId, string>>;
    initialMetric?: UsageQuery['metric'];
    initialLayoutId?: string | null;
    onLayoutChange?: (layoutId: string) => void;
}>): { -readonly [K in keyof ReturnType<typeof useCorePageWidgetAreaBinding>]: ReturnType<typeof useCorePageWidgetAreaBinding>[K] } & {
    presets: ReturnType<typeof createUsageWidgetPresets>;
} {
    // One Session has its own area and single view: the Account's named views say nothing about it.
    const session = input.sessionId !== undefined;
    const presets = React.useMemo(() => session ? createUsageSessionWidgetPresets(t('usage.sessionUsage'))
        : createUsageWidgetPresets(input.names, { initialMetric: input.initialMetric }), [session, input.names, input.initialMetric]);
    const context = React.useMemo(() => usageWidgetSurfaceContext(input.providedContext, input.period, input.sessionId), [input.providedContext, input.period, input.sessionId]);
    const binding = useCorePageWidgetAreaBinding({ serverId: input.serverId, pageId: 'usage', area: session ? USAGE_SESSION_WIDGET_AREA : 'main', presets, context,
        initialLayoutId: session ? null : input.initialLayoutId, onSelectLayout: session ? undefined : input.onLayoutChange });
    return React.useMemo(() => ({ ...binding, presets }), [binding, presets]);
}

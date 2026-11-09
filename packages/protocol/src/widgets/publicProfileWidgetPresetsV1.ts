import type { WidgetSizeV1 } from './widgetPresentationV1.js';
import type { BuiltinUsagePublicPresentationV1 } from './builtinWidgetDescriptorV1.js';
import type { WidgetAreaPresetV1 } from './widgetSurfaceArtifactV1.js';
import type { WidgetInputBindingsV1 } from './widgetInstanceV1.js';

/**
 * Starting compositions for the public page (PP-3): plain data mixed with at most three planet-art
 * blocks. Editorial data only: a person may still place whatever they like, and choosing a preset
 * never changes which facts are public.
 */
export const PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1 = ['minimal', 'dataRich', 'story', 'nightOwl'] as const;
export type PublicProfileLayoutPresetIdV1 = typeof PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1[number];

type Placement = readonly [id: string, size: WidgetSizeV1, presentation: BuiltinUsagePublicPresentationV1];
const sky = { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } as const satisfies BuiltinUsagePublicPresentationV1;
const crew = { kind: 'usage', widgetId: 'usage_breakdowns', inputs: { style: 'crew' } } as const satisfies BuiltinUsagePublicPresentationV1;
const planet = { kind: 'usage', widgetId: 'usage_planet', inputs: {} } as const satisfies BuiltinUsagePublicPresentationV1;
const orbit = { kind: 'usage', widgetId: 'usage_orbit', inputs: {} } as const satisfies BuiltinUsagePublicPresentationV1;
const totals = { kind: 'usage', widgetId: 'usage_period_summary', inputs: {} } as const satisfies BuiltinUsagePublicPresentationV1;
// Night owl reads the week's hours as levels (punch), never night-shift or sleep facts.
const hours = { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'weekdayHour' } } as const satisfies BuiltinUsagePublicPresentationV1;
const tide = { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'weekTide' } } as const satisfies BuiltinUsagePublicPresentationV1;
const parallel = { kind: 'usage', widgetId: 'usage_parallel', inputs: { style: 'peak' } } as const satisfies BuiltinUsagePublicPresentationV1;
const shipped = { kind: 'usage', widgetId: 'usage_outcomes', inputs: { style: 'shipped' } } as const satisfies BuiltinUsagePublicPresentationV1;

const PRESETS: Readonly<Record<PublicProfileLayoutPresetIdV1, readonly Placement[]>> = {
  minimal: [['totals', 'full', totals], ['days', 'full', sky], ['crew', 'medium', crew], ['planet', 'medium', planet]],
  dataRich: [['days', 'full', sky], ['crew', 'medium', crew], ['shipped', 'medium', shipped], ['orbit', 'wide', orbit]],
  story: [['planet', 'medium', planet], ['shipped', 'medium', shipped], ['days', 'full', sky], ['orbit', 'medium', orbit], ['crew', 'medium', crew]],
  nightOwl: [['hours', 'full', hours], ['totals', 'full', totals], ['tide', 'medium', tide], ['parallel', 'medium', parallel]],
};

/** The existing Account-area owner edits these same compositions; there is no profile draft store. */
export function createPublicProfileWidgetAreaPresetsV1(host?: Readonly<{
  names?: Readonly<Record<PublicProfileLayoutPresetIdV1, string>>;
  title?: (presentation: BuiltinUsagePublicPresentationV1) => string | undefined;
}>): readonly WidgetAreaPresetV1[] {
  const names = host?.names ?? { minimal: 'Minimal', dataRich: 'Data-rich', story: 'Story', nightOwl: 'Night owl' };
  return PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1.map(id => ({ id, name: names[id], items: PRESETS[id].map(([itemId, size, presentation]) => {
    const title = host?.title?.(presentation);
    const bindings: WidgetInputBindingsV1 = Object.fromEntries(Object.entries(presentation.inputs)
      .map(([key, value]) => [key, { kind: 'value' as const, value }]));
    return { kind: 'widget' as const, size, frameStyle: 'plain' as const,
      instance: { v: 1 as const, id: itemId, definition: { kind: 'builtin' as const, id: presentation.widgetId }, bindings,
        ...(title ? { displayName: title } : {}) } };
  }) }));
}

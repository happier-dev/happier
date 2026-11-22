import { lazyZodSchema } from '../lazyZodSchema.js';
import * as z from '../zodRuntimePolicy.js';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { instantiateWidgetLayoutFragmentGroupV1, type WidgetLayoutFragmentDraftV1, type WidgetLayoutFragmentGroupV1 } from './widgetLayoutFragmentV1.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';
import type { WidgetAreaPresetV1 } from './widgetSurfaceArtifactV1.js';
import { USAGE_QUERY_INPUT_FIELDS, UsageQuerySchema, type UsageQuery } from '../inputs/usageQuery.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import type { UsageAnalyticsBreakdownDimension } from '../usage/usageAnalyticsContracts.js';
import type { WidgetSizeV1 } from './widgetPresentationV1.js';
import { proposeWidgetInputDefaultBindingsV1 } from './widgetInputAdmissionV1.js';

export const USAGE_WIDGET_PRESET_IDS = ['overview', 'costs', 'work', 'usage', 'plans', 'coach', 'how-you-work', 'sources', 'agents'] as const;
export type UsageWidgetPresetId = typeof USAGE_WIDGET_PRESET_IDS[number];
const defaultNames: Readonly<Record<UsageWidgetPresetId, string>> = {
    overview: 'Overview', costs: 'Costs', work: 'Work', usage: 'Usage', plans: 'Plans', coach: 'Coach',
    'how-you-work': 'How you work', sources: 'Sources', agents: 'Agents',
};

const scopes = USAGE_QUERY_INPUT_FIELDS.filter(field => field.contextMode === 'follow');
const scopeSchema = () => PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(lazyZodSchema(() => z.pick(UsageQuerySchema, {
    period: true, agents: true, machines: true, projects: true, sources: true, session: true, costBasis: true,
})), { target: 'draft-7' }));

type PresetWidget = Readonly<{ id: string; size: WidgetSizeV1; metric?: UsageQuery['metric']; style?: string; colourBy?: 'intensity' | 'leadingAgent';
    breakdown?: readonly UsageAnalyticsBreakdownDimension[] }>;
type Arrangement = Readonly<{ width: 'half' | 'full'; widgets: readonly PresetWidget[] }>;
const w = (id: string, size: WidgetSizeV1, extra?: Omit<PresetWidget, 'id' | 'size'>): PresetWidget => ({ id, size, ...extra });
/**
 * Each host view is one Card · Lines group (lab `d2views`, `wgusage-CD`): declared sizes pack into the
 * group's two columns — Overview's period figures lead as one band, then the tall daily bars beside
 * capacity (lab d2views-OV) — and a phone stacks the same children in reading order.
 */
const arrangements: Readonly<Record<UsageWidgetPresetId, readonly Arrangement[]>> = {
    // The top band (lab d2top-A, PLAN U5): the daily bars take the left half and the period's figures over
    // Capacity the right half; a phone stacks them in that reading order. Efficiency beside Rhythm (both fill
    // from sessions), so on a first run both partners are empty together.
    overview: [{ width: 'full', widgets: [w('usage_daily', 'tall'), w('usage_period_summary', 'medium'),
        w('usage_capacity', 'medium'), w('usage_projections', 'full'), w('usage_coach', 'full'),
        w('usage_efficiency', 'medium'), w('usage_rhythm', 'medium')] }],
    // Cost facts holds the money facts and the prices line behind them, so it takes the full band. The daily
    // cost bars sit beside the agents' costs (lab d2views-COST 2-up), two lists of the same height; Efficiency is
    // one compact band, as on Usage, so no column runs past the chart beside it. Plan fit and Outcomes follow.
    costs: [{ width: 'full', widgets: [w('usage_cost_facts', 'full', { metric: 'cost' }), w('usage_daily', 'tall', { metric: 'cost' }),
        w('usage_breakdowns', 'tall', { metric: 'cost', breakdown: ['agent'] }), w('usage_efficiency', 'wide', { metric: 'cost' }),
        w('usage_plan_fit', 'full', { metric: 'cost' }), w('usage_outcomes', 'full', { metric: 'cost' })] }],
    work: [{ width: 'full', widgets: [w('usage_project_ledger', 'large'), w('usage_session_value', 'tall'), w('usage_outcomes', 'tall')] }],
    // Daily beside the model breakdown; Efficiency is one compact band, so a period without a basis
    // costs a line, never a tall empty cell beside the chart.
    usage: [{ width: 'full', widgets: [w('usage_daily', 'tall'), w('usage_breakdowns', 'tall', { breakdown: ['model'] }),
        w('usage_efficiency', 'wide'), w('usage_flow', 'full'), w('usage_breakdowns', 'full', { breakdown: ['machine'] })] }],
    // Lab p2sheet-D, a two-column sheet: Limits leads as a view of its own (large: the pool's cells and its order; a
    // full band elsewhere, such as Home, is the compact tile), then where each live window lands beside what each plan
    // is worth (two short lists: Plan fit is one line until a plan has a price), then the reset planner across the
    // coming days as its own band (acceptance 11-21 #3).
    plans: [{ width: 'full', widgets: [w('usage_capacity', 'large'), w('usage_projections', 'medium'), w('usage_plan_fit', 'medium'),
        w('usage_resets', 'full')] }],
    coach: [{ width: 'full', widgets: [w('usage_coach', 'large')] }],
    // Lab u3how: Sky of days leads, Steering by Agent takes its own band (its figures column needs the width), then A day in
    // agents beside Run length (both a row per Agent), Your planet beside Personal records (both short summaries of you),
    // and the typical week beside the typical day. Pairing like heights leaves no gap in either column (R4 leftover).
    'how-you-work': [{ width: 'full', widgets: [w('usage_rhythm', 'full', { style: 'sky', metric: 'busy', colourBy: 'leadingAgent' }),
        w('usage_human_loop', 'full', { style: 'tide' }), w('usage_parallel', 'medium', { style: 'lanes' }), w('usage_run_length', 'medium'),
        w('usage_planet', 'medium'), w('usage_recap', 'medium', { style: 'personalRecords' }),
        w('usage_rhythm', 'medium', { style: 'weekTide', metric: 'busy' }), w('usage_rhythm', 'medium', { style: 'daylight', metric: 'busy' })] }],
    sources: [{ width: 'full', widgets: [w('usage_sources', 'large'), w('usage_source_coverage', 'medium'), w('usage_unpriced', 'medium')] }],
    // Lab u3ens: the week's Score leads, Orbit beside Crew, the Agent river, Constellation and Shipped as bands.
    agents: [{ width: 'full', widgets: [w('usage_score', 'full'), w('usage_orbit', 'medium'),
        w('usage_breakdowns', 'medium', { style: 'crew', breakdown: ['agent'] }), w('usage_flow', 'full', { style: 'agentRiver' }),
        w('usage_constellation', 'full'), w('usage_outcomes', 'full', { style: 'shipped' })] }],
};

/** One Session's usage is its own question (why did it cost this): the autopsy, then what shaped it. */
export const USAGE_SESSION_WIDGET_PRESET_ID = 'session';
export const USAGE_SESSION_WIDGET_AREA = 'session';
const sessionArrangement: Arrangement = { width: 'full', widgets: [w('usage_session_value', 'large'),
    w('usage_breakdowns', 'medium', { breakdown: ['model'] }), w('usage_efficiency', 'medium')] };

function usageFragment(name: string, arrangement: Arrangement, overrideMetric?: UsageQuery['metric']): WidgetLayoutFragmentDraftV1 {
    const group: WidgetLayoutFragmentGroupV1 = {
        width: arrangement.width, frameStyle: 'card', dividers: 'hairline',
        children: arrangement.widgets.map(widget => {
            const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: widget.id })!;
            const defaults = proposeWidgetInputDefaultBindingsV1(descriptor);
            const metric = overrideMetric ?? widget.metric;
            return { kind: 'widget', size: widget.size,
            frameStyle: 'plain', instance: { v: 1, definition: { kind: 'builtin', id: widget.id }, bindings: {
                ...Object.fromEntries(descriptor.inputs!.fields
                    .filter(field => field.contextMode === 'follow').map(field => [field.path, { kind: 'context' as const, slot: field.path }])),
                // Legacy routes open Overview. Their presentation seed must
                // not replace the independent defaults of other named views.
                ...Object.fromEntries(descriptor.inputs!.fields.filter(field => field.contextMode === 'own').flatMap(field => {
                    const override = field.path === 'metric' ? metric : field.path === 'breakdown' && widget.breakdown ? [...widget.breakdown]
                        : field.path === 'style' ? widget.style : field.path === 'colourBy' ? widget.colourBy : undefined;
                    const binding = override === undefined ? defaults[field.path] : { kind: 'value' as const, value: override };
                    return binding ? [[field.path, binding]] : [];
                })),
            } } };
        }),
    };
    const applicableScopes = scopes.filter(field => group.children.some(child => Object.hasOwn(child.instance.bindings, field.path)));
    return { name, inputs: { fields: applicableScopes.map(field => ({ ...field, required: true })) }, inputSchema: scopeSchema(), group };
}

/** Portable fragments have no placement identities; the platform allocates each host occurrence. */
export function createUsageWidgetPresetFragments(names: Readonly<Record<UsageWidgetPresetId, string>>, options?: Readonly<{ initialMetric?: UsageQuery['metric'] }>):
    Readonly<Record<UsageWidgetPresetId, readonly WidgetLayoutFragmentDraftV1[]>> {
    const fragments: Partial<Record<UsageWidgetPresetId, readonly WidgetLayoutFragmentDraftV1[]>> = {};
    for (const id of USAGE_WIDGET_PRESET_IDS) fragments[id] = arrangements[id].map(arrangement =>
        usageFragment(names[id], arrangement, id === 'overview' ? options?.initialMetric : undefined));
    return fragments as Record<UsageWidgetPresetId, readonly WidgetLayoutFragmentDraftV1[]>;
}

/** The Session route's one view, in its own area so a Session never lists the Account's tabs. */
export function createUsageSessionWidgetPresets(name = 'Session'): readonly WidgetAreaPresetV1[] {
    const fragment = usageFragment(name, sessionArrangement);
    return [{ id: USAGE_SESSION_WIDGET_PRESET_ID, name, items: [instantiateWidgetLayoutFragmentGroupV1(fragment.group, {
        groupId: `${USAGE_SESSION_WIDGET_PRESET_ID}:group:0`,
        childIds: fragment.group.children.map((_, child) => `${USAGE_SESSION_WIDGET_PRESET_ID}:group:0:widget:${child}`) })] }];
}

/** Host metadata is localized by the mounted page, never read from a caller's layout input. */
export function createUsageWidgetPresets(names: Readonly<Record<UsageWidgetPresetId, string>> = defaultNames, options?: Readonly<{ initialMetric?: UsageQuery['metric'] }>): readonly WidgetAreaPresetV1[] {
    const fragments = createUsageWidgetPresetFragments(names, options);
    return USAGE_WIDGET_PRESET_IDS.map(id => ({ id, name: names[id], items: fragments[id].map((fragment, index) =>
        instantiateWidgetLayoutFragmentGroupV1(fragment.group, { groupId: `${id}:group:${index}`,
            childIds: fragment.group.children.map((_, child) => `${id}:group:${index}:widget:${child}`) })) }));
}

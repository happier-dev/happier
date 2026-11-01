import type { InputHints } from '../inputs/inputFields.js';
import { readWidgetInputTargetV1, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetDefinitionRefV1, WidgetInstanceV1 } from './widgetInstanceV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { WidgetSizeDeclarationV1 } from './widgetPresentationV1.js';
import { z } from 'zod/mini';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { lazyDefinition } from '../lazyZodSchema.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { WorkspaceRefV1WriteSchema } from '../workspaces/workspaceRefV1.js';
import type { WidgetLayoutWidgetV1 } from './widgetLayoutItemV1.js';
import { USAGE_QUERY_INPUT_FIELDS, USAGE_MULTI_BREAKDOWN_INPUT_FIELD, UsageAccountingMetricSchema, UsageQuerySchema, UsageSourceInventoryScopeSchema } from '../inputs/usageQuery.js';
import { MachineTargetV1Schema } from '../machines/machineAccessV1.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import type { InputFieldHint } from '../inputs/inputFields.js';

/** Native Session content identities; presentation references and configured copies share this owner. */
export const SESSION_COMPANION_BUILTIN_ITEM_IDS = ['session_summary', 'agent_plan', 'changes', 'local_services'] as const;
export const PROJECT_BUILTIN_WIDGET_IDS_V1 = ['project_about', 'project_code', 'project_readme', 'project_checkouts', 'project_scripts', 'project_sessions', 'project_changes'] as const;
export const USAGE_BUILTIN_WIDGET_IDS_V1 = ['usage_daily', 'usage_period_summary', 'usage_cost_facts', 'usage_flow', 'usage_efficiency', 'usage_breakdowns',
    'usage_capacity', 'usage_projections', 'usage_resets', 'usage_plan_fit', 'usage_project_ledger', 'usage_session_value', 'usage_outcomes', 'usage_coach',
    'usage_rhythm', 'usage_parallel', 'usage_human_loop', 'usage_night_shift', 'usage_recap', 'usage_footprint', 'usage_sources', 'usage_source_coverage', 'usage_unpriced',
    'usage_score', 'usage_orbit', 'usage_constellation', 'usage_planet', 'usage_run_length',
    'usage_machines', 'usage_projects', 'usage_atmosphere'] as const;
export type SessionBuiltinWidgetIdV1 = (typeof SESSION_COMPANION_BUILTIN_ITEM_IDS)[number];
export type ProjectBuiltinWidgetIdV1 = (typeof PROJECT_BUILTIN_WIDGET_IDS_V1)[number];
export type UsageBuiltinWidgetIdV1 = (typeof USAGE_BUILTIN_WIDGET_IDS_V1)[number];
export const MACHINE_BUILTIN_WIDGET_IDS_V1 = ['machine_vitals', 'machine_fleet', 'machine_metric', 'machine_top_consumers',
    'machine_left_behind', 'machine_storage', 'machine_worktrees', 'machine_guard', 'machine_activity', 'machine_cleanup_suggestion'] as const;
export type MachineBuiltinWidgetIdV1 = (typeof MACHINE_BUILTIN_WIDGET_IDS_V1)[number];
/** No-input Home reads; a separate Services identity preserves saved Session-scoped copies. */
export const HOME_BUILTIN_WIDGET_IDS_V1 = ['your_home', 'local_services_app'] as const;
export type HomeBuiltinWidgetIdV1 = (typeof HOME_BUILTIN_WIDGET_IDS_V1)[number];
export type BuiltinWidgetIdV1 = SessionBuiltinWidgetIdV1 | ProjectBuiltinWidgetIdV1 | UsageBuiltinWidgetIdV1 | MachineBuiltinWidgetIdV1 | HomeBuiltinWidgetIdV1;
/** Saved executable declarations accept only identities owned by this catalog. */
export const BuiltinWidgetIdV1Schema = z.enum([...SESSION_COMPANION_BUILTIN_ITEM_IDS, ...PROJECT_BUILTIN_WIDGET_IDS_V1,
    ...USAGE_BUILTIN_WIDGET_IDS_V1, ...MACHINE_BUILTIN_WIDGET_IDS_V1, ...HOME_BUILTIN_WIDGET_IDS_V1]);

/** Copied public presentation declarations, not a second catalog or disclosure-policy owner. */
function usagePublicPresentation(id: UsageBuiltinWidgetIdV1) {
    const empty = z.strictObject({});
    switch (id) {
        case 'usage_rhythm': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id), inputs: z.strictObject({
            style: z._default(z.enum(['heatmap', 'weekdayHour', 'sky', 'weekTide', 'daylight',
                'ninetyPlanets', 'streakThread', 'weeksSkyline', 'daysOnSurface', 'ringedStreaks', 'aroundPeriod']), 'sky'),
            colourBy: z.optional(z.literal('intensity')),
        }) });
        case 'usage_parallel': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.literal('peak') }) });
        case 'usage_constellation': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.literal('agentMix') }) });
        case 'usage_flow': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.literal('agentRiver') }) });
        case 'usage_breakdowns': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.optional(z.enum(['breakdowns', 'crew'])) }) });
        case 'usage_outcomes': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.optional(z.enum(['outcomes', 'shipped'])) }) });
        case 'usage_recap': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.optional(z.enum(['recap', 'personalRecords'])) }) });
        case 'usage_orbit': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.optional(z.enum(['orbit', 'moons'])) }) });
        case 'usage_run_length': return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id),
            inputs: z.strictObject({ style: z.optional(z.enum(['runLength', 'galaxy'])) }) });
        case 'usage_daily': case 'usage_period_summary': case 'usage_footprint': case 'usage_source_coverage':
        case 'usage_planet': case 'usage_machines': case 'usage_projects': case 'usage_atmosphere':
            return z.strictObject({ kind: z.literal('usage'), widgetId: z.literal(id), inputs: empty });
        default: return null;
    }
}
/** PP2 embeds this closed arm in its copied layout; no private pins, metrics, Resources or Actions. */
export const BuiltinUsagePublicPresentationV1Schema = lazyDefinition(() => z.union(USAGE_BUILTIN_WIDGET_IDS_V1.flatMap(id => {
    const declaration = usagePublicPresentation(id);
    return declaration ? [declaration] : [];
})));
export type BuiltinUsagePublicPresentationV1 = z.infer<typeof BuiltinUsagePublicPresentationV1Schema>;

/**
 * Missing default Overview only: render without writing, then retain the whole layout on its first edit.
 * The preset makes no frame choice, so each widget follows its area's default until the person picks one.
 */
export function projectOverviewDefaultPlacementsV1(): WidgetLayoutWidgetV1[] {
    return [
        ...(['code', 'readme'] as const).map(id => ({ id, area: 'main' as const })),
        ...(['about', 'changes', 'checkouts', 'scripts', 'sessions'] as const).map(id => ({ id, area: 'aside' as const })),
    ].map(({ id, area }) => ({ kind: 'widget' as const, area, instance: {
        v: 1, id, definition: { kind: 'builtin', id: `project_${id}` }, bindings: { checkout: { kind: 'context', slot: 'checkout' } },
    } }));
}

const localServicesMetadata = { title: 'Local services', titleKey: 'widgetGlances.localServicesTitle', icon: 'hard-drives' } as const;
const nativeMetadata = {
    session_summary: { title: 'Session summary', titleKey: 'sessionBoard.companion.summary.title', icon: 'stack' },
    agent_plan: { title: 'Agent plan', titleKey: 'sessionCompanion.plan.title', icon: 'list-checks' },
    changes: { title: 'Changes', titleKey: 'widgetGlances.changesTitle', icon: 'git-branch' },
    local_services: localServicesMetadata,
    local_services_app: localServicesMetadata,
    project_about: { title: 'About', titleKey: 'projects.widgets.about', icon: 'info' },
    project_code: { title: 'Code', titleKey: 'projects.pages.code', icon: 'code' },
    project_readme: { title: 'README', titleKey: 'projects.widgets.readme', icon: 'file-text' },
    project_checkouts: { title: 'Checkouts', titleKey: 'projects.widgets.checkouts', icon: 'git-branch' },
    project_scripts: { title: 'Scripts', titleKey: 'projects.pages.scripts', icon: 'play' },
    project_sessions: { title: 'Sessions', titleKey: 'projects.widgets.sessions', icon: 'chats-circle' },
    project_changes: { title: 'Local changes', titleKey: 'projects.widgets.localChanges', icon: 'git-branch' },
    usage_daily: { title: 'Daily usage', titleKey: 'usage.widgets.usage_daily', descriptionKey: 'usage.board.page.purposeDaily', icon: 'chart-bar' },
    usage_period_summary: { title: 'Period summary', titleKey: 'usage.widgets.usage_period_summary', descriptionKey: 'usage.board.page.purposeSummary', icon: 'squares-four' },
    usage_cost_facts: { title: 'Cost facts', titleKey: 'usage.widgets.usage_cost_facts', descriptionKey: 'usage.board.page.purposeCostFacts', icon: 'currency-dollar' },
    usage_flow: { title: 'Usage flow', titleKey: 'usage.widgets.usage_flow', descriptionKey: 'usage.board.page.purposeFlow', icon: 'chart-line' },
    usage_efficiency: { title: 'Efficiency', titleKey: 'usage.widgets.usage_efficiency', descriptionKey: 'usage.board.page.purposeEfficiency', icon: 'pulse' },
    usage_breakdowns: { title: 'Breakdowns', titleKey: 'usage.widgets.usage_breakdowns', descriptionKey: 'usage.board.page.purposeBreakdowns', icon: 'list-bullets' },
    usage_capacity: { title: 'Capacity', titleKey: 'usage.widgets.usage_capacity', descriptionKey: 'usage.board.page.purposeCapacity', icon: 'speedometer' },
    usage_projections: { title: 'Projections', titleKey: 'usage.widgets.usage_projections', descriptionKey: 'usage.board.page.purposeProjections', icon: 'hourglass' },
    usage_resets: { title: 'Resets', titleKey: 'usage.widgets.usage_resets', descriptionKey: 'usage.board.page.purposeResets', icon: 'timer' },
    usage_plan_fit: { title: 'Plan fit', titleKey: 'usage.widgets.usage_plan_fit', descriptionKey: 'usage.board.page.purposePlanFit', icon: 'currency-dollar' },
    usage_project_ledger: { title: 'Project ledger', titleKey: 'usage.widgets.usage_project_ledger', descriptionKey: 'usage.board.page.purposeLedger', icon: 'git-branch' },
    usage_session_value: { title: 'Session value', titleKey: 'usage.widgets.usage_session_value', descriptionKey: 'usage.board.page.purposeSessionValue', icon: 'chart-line' },
    usage_outcomes: { title: 'Outcomes', titleKey: 'usage.widgets.usage_outcomes', descriptionKey: 'usage.board.page.purposeOutcomes', icon: 'git-pull-request' },
    usage_coach: { title: 'Coach', titleKey: 'usage.widgets.usage_coach', descriptionKey: 'usage.board.page.purposeCoach', icon: 'sparkle' },
    usage_rhythm: { title: 'Rhythm', titleKey: 'usage.widgets.usage_rhythm', descriptionKey: 'usage.board.page.purposeRhythm', icon: 'clock' },
    usage_parallel: { title: 'Parallel work', titleKey: 'usage.widgets.usage_parallel', descriptionKey: 'usage.board.page.purposeParallel', icon: 'stack-simple' },
    usage_human_loop: { title: 'Human loop', titleKey: 'usage.widgets.usage_human_loop', descriptionKey: 'usage.board.page.purposeHumanLoop', icon: 'hand' },
    usage_night_shift: { title: 'Night shift', titleKey: 'usage.widgets.usage_night_shift', descriptionKey: 'usage.board.page.purposeNightShift', icon: 'moon' },
    usage_recap: { title: 'Recap', titleKey: 'usage.widgets.usage_recap', descriptionKey: 'usage.board.page.purposeRecap', icon: 'sparkle' },
    usage_footprint: { title: 'Footprint', titleKey: 'usage.widgets.usage_footprint', descriptionKey: 'usage.board.page.purposeFootprint', icon: 'leaf' },
    usage_sources: { title: 'Sources', titleKey: 'usage.widgets.usage_sources', descriptionKey: 'usage.board.page.purposeSources', icon: 'stack' },
    usage_source_coverage: { title: 'Coverage', titleKey: 'usage.widgets.usage_source_coverage', descriptionKey: 'usage.board.sources.coveragePurpose', icon: 'stack' },
    usage_unpriced: { title: 'Unpriced', titleKey: 'usage.widgets.usage_unpriced', descriptionKey: 'usage.board.sources.unpricedPurpose', icon: 'currency-dollar' },
    usage_score: { title: 'Score dots', titleKey: 'usage.widgets.usage_score', icon: 'chart-bar' },
    usage_orbit: { title: 'Orbit', titleKey: 'usage.widgets.usage_orbit', icon: 'planet' },
    usage_constellation: { title: 'Constellation', titleKey: 'usage.widgets.usage_constellation', icon: 'graph' },
    usage_planet: { title: 'Your planet', titleKey: 'usage.widgets.usage_planet', icon: 'planet' },
    usage_run_length: { title: 'Run length', titleKey: 'usage.widgets.usage_run_length', icon: 'timer' },
    usage_machines: { title: 'Machines', titleKey: 'usage.widgets.usage_machines', icon: 'desktop' },
    usage_projects: { title: 'Projects', titleKey: 'usage.widgets.usage_projects', icon: 'git-branch' },
    usage_atmosphere: { title: 'Atmosphere', titleKey: 'usage.widgets.usage_atmosphere', icon: 'planet' },
    machine_vitals: { title: 'Vitals', titleKey: 'machines.widgets.machine_vitals', descriptionKey: 'machines.widgets.body.purpose.machine_vitals', icon: 'pulse' },
    machine_fleet: { title: 'Machines', titleKey: 'machines.widgets.machine_fleet', descriptionKey: 'machines.widgets.body.purpose.machine_fleet', icon: 'desktop' },
    machine_metric: { title: 'Metric', titleKey: 'machines.widgets.machine_metric', descriptionKey: 'machines.widgets.body.purpose.machine_metric', icon: 'chart-line' },
    machine_top_consumers: { title: 'Using the most', titleKey: 'machines.widgets.machine_top_consumers', descriptionKey: 'machines.widgets.body.purpose.machine_top_consumers', icon: 'list-bullets' },
    machine_left_behind: { title: 'Left behind', titleKey: 'machines.widgets.machine_left_behind', descriptionKey: 'machines.widgets.body.purpose.machine_left_behind', icon: 'clock' },
    machine_storage: { title: 'Storage', titleKey: 'machines.widgets.machine_storage', descriptionKey: 'machines.widgets.body.purpose.machine_storage', icon: 'hard-drives' },
    machine_worktrees: { title: 'Worktrees', titleKey: 'machines.widgets.machine_worktrees', descriptionKey: 'machines.widgets.body.purpose.machine_worktrees', icon: 'git-branch' },
    machine_guard: { title: 'Guard', titleKey: 'machines.widgets.machine_guard', descriptionKey: 'machines.widgets.body.purpose.machine_guard', icon: 'shield' },
    machine_activity: { title: 'Activity', titleKey: 'machines.widgets.machine_activity', descriptionKey: 'machines.widgets.body.purpose.machine_activity', icon: 'clock' },
    machine_cleanup_suggestion: { title: 'Suggestion', titleKey: 'machines.widgets.machine_cleanup_suggestion', descriptionKey: 'machines.widgets.body.purpose.machine_cleanup_suggestion', icon: 'sparkle' },
    your_home: { title: 'Your Home', titleKey: 'homeWidgets.yourHomeTitle', descriptionKey: 'homeWidgets.yourHomeDescription', icon: 'house' },
} as const;

/** Gallery/default block titles and input schemas use the same declaration that admits the copy. */
export function readBuiltinUsagePublicPresentationDescriptorV1(widgetId: string) {
    const id = USAGE_BUILTIN_WIDGET_IDS_V1.find(id => id === widgetId);
    const declaration = id ? usagePublicPresentation(id) : null;
    return id && declaration ? { ...nativeMetadata[id], widgetId: id,
        inputSchema: PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(declaration.shape.inputs, { target: 'draft-7' })),
    } : null;
}

const inputs: InputHints = { fields: [{ path: 'session', title: 'Session', prompt: 'Which session?', description: 'The session it shows; it reads that session where it runs.', widget: 'select', inputType: { hostType: 'session' }, required: true, optionsSourceId: 'sessions' }] };
const sessionInputs: WidgetInputDescriptorV1 = {
    inputs,
    inputSchema: { type: 'object', properties: { session: { type: 'object', properties: {
        serverId: { type: 'string', minLength: 1 }, sessionId: { type: 'string', minLength: 1 },
    }, required: ['serverId', 'sessionId'], additionalProperties: false } }, required: ['session'], additionalProperties: false },
};
const nativeSizeDeclaration = { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' } satisfies WidgetSizeDeclarationV1;
const workspaceInputSchema = lazyDefinition(() => PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(z.strictObject({
    checkout: WorkspaceRefV1WriteSchema,
}), { target: 'draft-7' })));
const workspaceInputs: WidgetInputDescriptorV1 = {
    inputs: { fields: [{ path: 'checkout', title: 'Checkout', prompt: 'Which checkout?', widget: 'select', inputType: { hostType: 'workspace' }, required: true }] },
    inputSchema: workspaceInputSchema,
};
/** Presentation inputs belong only to bodies that actually consume them. Query scope stays shared. */
const usagePresentationInputs: Readonly<Partial<Record<UsageBuiltinWidgetIdV1, readonly ('metric' | 'breakdown')[]>>> = {
    usage_daily: ['metric'], usage_period_summary: ['metric'], usage_flow: ['metric', 'breakdown'],
    usage_breakdowns: ['metric', 'breakdown'], usage_project_ledger: ['metric'], usage_session_value: ['metric'],
    usage_outcomes: ['metric'], usage_recap: ['metric'], usage_rhythm: ['metric'],
};
function usageInputs(id: UsageBuiltinWidgetIdV1): WidgetInputDescriptorV1 {
    const styles = id === 'usage_breakdowns' ? ['breakdowns', 'crew'] as const
        : id === 'usage_flow' ? ['flow', 'agentRiver'] as const
        : id === 'usage_outcomes' ? ['outcomes', 'shipped'] as const
        : id === 'usage_rhythm' ? ['heatmap', 'weekdayHour', 'sky', 'weekTide', 'daylight',
            'ninetyPlanets', 'streakThread', 'weeksSkyline', 'daysOnSurface', 'ringedStreaks', 'aroundPeriod'] as const
        : id === 'usage_orbit' ? ['orbit', 'moons'] as const
        : id === 'usage_run_length' ? ['runLength', 'galaxy'] as const
        // The retained machine timeline is a distinct existing question, not a saved-copy rewrite.
        : id === 'usage_parallel' ? ['lanes', 'dial', 'timeline'] as const
        : id === 'usage_recap' ? ['recap', 'personalRecords'] as const
        : id === 'usage_human_loop' ? ['humanLoop', 'tide'] as const : null;
    const labels: Readonly<Record<string, string>> = { breakdowns: 'Breakdowns', crew: 'Crew', flow: 'Flow', agentRiver: 'Agent river',
        outcomes: 'Outcomes', shipped: 'Shipped', heatmap: 'Calendar', weekdayHour: 'Weekday / hour', sky: 'Sky of days',
        weekTide: 'Week tide', daylight: 'Daylight', lanes: 'Lanes', dial: 'Dial', timeline: 'Machine timeline', recap: 'Recap',
        personalRecords: 'Personal records', humanLoop: 'Human loop', tide: 'Steering by Agent',
        ninetyPlanets: 'Planets of the period', streakThread: 'Streak thread', weeksSkyline: 'Weeks skyline',
        daysOnSurface: 'Days on the surface', ringedStreaks: 'Ringed by streaks', aroundPeriod: 'Around the period',
        orbit: 'Orbit', moons: 'Moons', runLength: 'Run length', galaxy: 'Galaxy of sessions' };
    const fields: InputFieldHint[] = USAGE_QUERY_INPUT_FIELDS.filter(field => field.contextMode === 'follow'
        || usagePresentationInputs[id]?.some(path => path === field.path))
        .map(field => ({ ...(id === 'usage_breakdowns' && field.path === 'breakdown' ? USAGE_MULTI_BREAKDOWN_INPUT_FIELD : field),
            ...(field.path === 'metric' && id !== 'usage_rhythm' ? { options: field.options?.filter(option => option.value === 'tokens' || option.value === 'cost') } : {}),
            required: field.required ?? true }));
    if (id === 'usage_rhythm') {
        const metric = fields.find(field => field.path === 'metric')!;
        metric.required = false; // Retained copies predate the Metric input.
        // The incumbent combined activity composition has no selected-measure encoding.
        metric.visibleWhen = { op: 'or', any: ['sky', 'weekTide', 'daylight'].map(value => ({ op: 'eq', path: 'style', value })) };
    }
    if (styles) fields.push({ path: 'style', title: 'Style', widget: 'select', contextMode: 'own',
        options: styles.map(value => ({ value, label: labels[value]! })) });
    if (id === 'usage_rhythm') fields.push({ path: 'colourBy', title: 'Colour by', widget: 'select', contextMode: 'own',
        visibleWhen: { op: 'eq', path: 'style', value: 'sky' },
        options: [{ value: 'intensity', label: 'Intensity' }, { value: 'leadingAgent', label: 'Leading Agent' }] });
    if (id === 'usage_parallel' || id === 'usage_score') fields.push({ path: 'day', title: 'Day', widget: 'text', contextMode: 'own' });
    return { inputs: { fields }, inputSchema: lazyDefinition(() => PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(
        z.extend(UsageQuerySchema, {
            ...(id === 'usage_rhythm' ? { metric: z._default(UsageQuerySchema.shape.metric._zod.def.innerType, 'busy'),
                colourBy: z._default(z.enum(['intensity', 'leadingAgent']), 'intensity') }
                : { metric: z._default(UsageAccountingMetricSchema, 'tokens') }),
            ...(styles ? { style: z._default(z.enum(styles), styles[0]) } : {}),
            ...(id === 'usage_parallel' || id === 'usage_score' ? { day: z.optional(z.iso.date()) } : {}),
        }), { target: 'draft-7' }))) };
}
const sourceInventoryInputs: WidgetInputDescriptorV1 = {
    inputs: { fields: USAGE_QUERY_INPUT_FIELDS.filter(field => ['agents', 'machines', 'sources'].includes(field.path))
        .map(field => ({ ...field, required: field.required ?? true })) },
    inputSchema: lazyDefinition(() => PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(UsageSourceInventoryScopeSchema, { target: 'draft-7' }))),
};

const machineField: InputFieldHint = { path: 'machine', title: 'Machine', prompt: 'Which machine?', widget: 'select',
    inputType: { hostType: 'machine' }, contextMode: 'follow', required: true };
const volumeField: InputFieldHint = { path: 'volume', title: 'Volume', widget: 'select', contextMode: 'follow',
    optionsSourceId: 'machines.volumes.available' };
const machineChoiceLabels: Readonly<Record<string, string>> = { cpu: 'CPU', memory: 'Memory', disk: 'Disk', disk_free: 'Disk free',
    network: 'Network', '1h': '1 hour', '24h': '24 hours', '7d': '7 days', machine: 'Machine', session: 'Session',
    sparklines: 'Sparklines', bars: 'Bars', numbers: 'Numbers', rings: 'Rings' };
const choices = (values: readonly string[]) => values.map(value => ({ value, label: machineChoiceLabels[value] ?? value }));
function machineWidgetContract(id: MachineBuiltinWidgetIdV1): WidgetInputDescriptorV1 & { sizeDeclaration: WidgetSizeDeclarationV1 } {
    let fields: InputFieldHint[] = [{ ...machineField, ...(id === 'machine_activity' ? { required: false } : {}) }];
    let schema: z.ZodMiniType = z.strictObject({ machine: id === 'machine_activity' ? z.optional(MachineTargetV1Schema) : MachineTargetV1Schema });
    if (id === 'machine_fleet') {
        fields = [{ path: 'style', title: 'Style', widget: 'select', contextMode: 'own', options: choices(['sparklines', 'bars', 'numbers', 'rings']) },
            { path: 'metrics', title: 'Metrics', widget: 'multiselect', contextMode: 'own', options: choices(['cpu', 'memory', 'disk', 'network']) }];
        schema = z.strictObject({ style: z.optional(z.enum(['sparklines', 'bars', 'numbers', 'rings'])),
            metrics: z.optional(z.array(z.enum(['cpu', 'memory', 'disk', 'network']))) });
    } else if (id === 'machine_metric') {
        const disk = { op: 'eq' as const, path: 'metric', value: 'disk_free' };
        fields.push({ path: 'metric', title: 'Metric', widget: 'select', contextMode: 'own', options: choices(['cpu', 'memory', 'disk_free', 'network']) },
            { path: 'range', title: 'Range', widget: 'select', contextMode: 'own', options: choices(['1h', '24h', '7d']) },
            { ...volumeField, visibleWhen: disk }, { path: 'warnAbove', title: 'Warn above', widget: 'number', contextMode: 'own' });
        // The body reads an unset metric as CPU over the last hour; the declaration says so, so setup
        // starts on those choices instead of showing none selected.
        schema = z.strictObject({ machine: MachineTargetV1Schema, metric: z._default(z.enum(['cpu', 'memory', 'disk_free', 'network']), 'cpu'),
            range: z._default(z.enum(['1h', '24h', '7d']), '1h'), volume: z.optional(z.string().check(z.minLength(1))), warnAbove: z.optional(z.number().check(z.nonnegative())) });
    } else if (id === 'machine_storage') {
        fields.push(volumeField);
        schema = z.strictObject({ machine: MachineTargetV1Schema, volume: z.optional(z.string().check(z.minLength(1))) });
    } else if (id === 'machine_top_consumers') {
        const session = { op: 'eq' as const, path: 'scope', value: 'session' };
        fields.push({ path: 'scope', title: 'Scope', widget: 'select', contextMode: 'own', options: choices(['machine', 'session']) },
            { path: 'session', title: 'Session', widget: 'json', contextMode: 'follow', visibleWhen: session, requiredWhen: session });
        schema = z.strictObject({ machine: MachineTargetV1Schema, scope: z._default(z.enum(['machine', 'session']), 'machine'),
            session: z.optional(VoiceTrackedSessionAddressV1Schema) });
    } else if (id === 'machine_worktrees') {
        fields.push({ path: 'project', title: 'Project', widget: 'text', contextMode: 'follow' });
        schema = z.strictObject({ machine: MachineTargetV1Schema, project: z.optional(z.string().check(z.minLength(1))) });
    }
    const fourSizes = id === 'machine_left_behind' || id === 'machine_worktrees' || id === 'machine_cleanup_suggestion';
    const defaultSize = id === 'machine_fleet' ? 'wide' : id === 'machine_vitals' || id === 'machine_left_behind' || id === 'machine_worktrees' ? 'small' : 'medium';
    return { inputs: { fields }, inputSchema: lazyDefinition(() => PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' }))),
        sizeDeclaration: { sizes: fourSizes ? ['small', 'medium', 'wide', 'full'] : nativeSizeDeclaration.sizes, defaultSize } };
}

/** Descriptor projection only: execution, data and Actions stay with the existing native domains. */
type NativeDescriptor = WidgetInputDescriptorV1 & Readonly<{
    sizeDeclaration: WidgetSizeDeclarationV1;
    definition: Readonly<{ kind: 'builtin'; id: BuiltinWidgetIdV1 }>;
    surface?: never;
    title: string; titleKey: (typeof nativeMetadata)[BuiltinWidgetIdV1]['titleKey'];
    /** The one question the widget answers, for the gallery; definitions without one show their provenance. */
    descriptionKey?: Extract<(typeof nativeMetadata)[BuiltinWidgetIdV1], { descriptionKey: string }>['descriptionKey'];
    icon: (typeof nativeMetadata)[BuiltinWidgetIdV1]['icon'];
    key: string; target: 'session' | 'app'; homeDefault: 'available'; availability: 'available';
}>;
export const BUILTIN_WIDGET_DESCRIPTORS_V1 = Object.freeze([...SESSION_COMPANION_BUILTIN_ITEM_IDS.map((id): NativeDescriptor => Object.freeze({
    ...sessionInputs, ...nativeMetadata[id], definition: { kind: 'builtin' as const, id },
    sizeDeclaration: nativeSizeDeclaration,
    key: `builtin:${id}`, target: readWidgetInputTargetV1(sessionInputs).kind === 'session' ? 'session' : 'app', homeDefault: 'available' as const, availability: 'available' as const,
})), ...PROJECT_BUILTIN_WIDGET_IDS_V1.map((id): NativeDescriptor => Object.freeze({
    ...workspaceInputs, ...nativeMetadata[id], definition: { kind: 'builtin' as const, id },
    sizeDeclaration: nativeSizeDeclaration, key: `builtin:${id}`, target: readWidgetInputTargetV1(workspaceInputs).kind === 'session' ? 'session' : 'app',
    homeDefault: 'available' as const, availability: 'available' as const,
})), ...USAGE_BUILTIN_WIDGET_IDS_V1.map((id): NativeDescriptor => Object.freeze({
    ...(id === 'usage_sources' ? sourceInventoryInputs : usageInputs(id)), ...nativeMetadata[id], definition: { kind: 'builtin' as const, id },
    sizeDeclaration: id === 'usage_projects' ? { sizes: ['wide', 'full'], defaultSize: 'wide' } satisfies WidgetSizeDeclarationV1
        : id === 'usage_atmosphere' ? { sizes: ['medium', 'full'], defaultSize: 'medium' } satisfies WidgetSizeDeclarationV1
        : id === 'usage_machines' ? { sizes: ['small', 'medium', 'full'], defaultSize: 'medium' } satisfies WidgetSizeDeclarationV1
        : nativeSizeDeclaration, key: `builtin:${id}`, target: 'app',
    homeDefault: 'available', availability: 'available',
})), ...MACHINE_BUILTIN_WIDGET_IDS_V1.map((id): NativeDescriptor => Object.freeze({
    ...machineWidgetContract(id), ...nativeMetadata[id], definition: { kind: 'builtin' as const, id },
    key: `builtin:${id}`, target: 'app', homeDefault: 'available', availability: 'available',
})), ...HOME_BUILTIN_WIDGET_IDS_V1.map((id): NativeDescriptor => Object.freeze({
    ...nativeMetadata[id], definition: { kind: 'builtin' as const, id },
    // An App read with no inputs, at the four sizes the lab composes.
    sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full'], defaultSize: 'medium' } satisfies WidgetSizeDeclarationV1,
    key: `builtin:${id}`, target: 'app', homeDefault: 'available', availability: 'available',
}))]);
export type BuiltinWidgetDescriptorV1 = NativeDescriptor;

export function readBuiltinWidgetDescriptorV1(definition: WidgetDefinitionRefV1): BuiltinWidgetDescriptorV1 | null {
    return definition.kind === 'builtin' ? BUILTIN_WIDGET_DESCRIPTORS_V1.find(row => row.definition.id === definition.id) ?? null : null;
}

export type WidgetCandidateIdentityV1 = Readonly<{ surface: Extract<WidgetDefinitionRefV1, { kind: 'installed' }>['surface']; definition?: never }>
    | Readonly<{ definition: Exclude<WidgetDefinitionRefV1, { kind: 'installed' }>; surface?: never }>;

export function widgetCandidateDefinitionV1(candidate: WidgetCandidateIdentityV1): WidgetDefinitionRefV1 {
    return candidate.surface ? { kind: 'installed', surface: candidate.surface } : candidate.definition;
}

export function isSameWidgetDefinitionV1(left: WidgetDefinitionRefV1, right: WidgetDefinitionRefV1): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'builtin' && right.kind === 'builtin') return left.id === right.id;
    if (left.kind === 'artifact' && right.kind === 'artifact') return left.artifactId === right.artifactId;
    if (left.kind === 'inline' && right.kind === 'inline') return sameStrictJsonValue(left.definition, right.definition);
    return left.kind === 'installed' && right.kind === 'installed'
        && left.surface.pluginId === right.surface.pluginId && left.surface.localId === right.surface.localId;
}

/** Gallery copies include explicit shared publications; the Artifact reader enforces id = artifactId. */
export function countWidgetInstancesV1(instances: Iterable<Pick<WidgetInstanceV1, 'definition'>>, definition: WidgetDefinitionRefV1): number {
    let count = 0;
    for (const instance of instances) {
        if (isSameWidgetDefinitionV1(instance.definition, definition)
            || (definition.kind === 'artifact' && instance.definition.kind === 'inline' && instance.definition.definition.id === definition.artifactId)) count += 1;
    }
    return count;
}

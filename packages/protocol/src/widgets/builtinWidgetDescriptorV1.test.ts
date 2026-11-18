import { describe, expect, it } from 'vitest';
import { projectOverviewDefaultPlacementsV1, readBuiltinWidgetDescriptorV1, readUsageBreakdownsInstanceTitleV1, SESSION_COMPANION_BUILTIN_ITEM_IDS, BuiltinUsagePublicPresentationV1Schema } from './builtinWidgetDescriptorV1.js';
import { isWidgetTargetHostableV1, readWidgetInputTargetV1, resolveConfiguredWidgetInputs, resolveConfiguredWidgetTargetInputV1, validateWidgetWorkspaceInputV1, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import { composeWidgetGroupContextV1 } from './widgetActionInputResolverV1.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { setWidgetInputBindingsV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';
import { proposeWidgetInputDefaultBindingsV1 } from './widgetInputAdmissionV1.js';
import { createUsageWidgetPresets } from './usageWidgetPresetsV1.js';
import { resolveEffectiveInputFields } from '../inputs/inputFieldRuntime.js';

describe('native widget target contracts', () => {
    it('admits Readiness only on its Project without a checkout or Session', () => {
        const definition = { kind: 'builtin', id: 'project_readiness' } as const;
        const descriptor = readBuiltinWidgetDescriptorV1(definition);
        expect(descriptor).toMatchObject({ target: 'project' });
        expect(isWidgetTargetHostableV1(descriptor!, 'project')).toBe(true);
        expect(isWidgetTargetHostableV1(descriptor!, 'home')).toBe(false);
        expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
            v: 1, id: 'readiness', definition, bindings: {},
        }, providedContext: {}, viewerValues: {} })).toEqual({ status: 'ready', input: {} });
    });
    it('admits Automations on its logical Project without a checkout, and the default Overview places it after Scripts', () => {
        const definition = { kind: 'builtin', id: 'project_automations' } as const;
        const descriptor = readBuiltinWidgetDescriptorV1(definition);
        expect(descriptor).toMatchObject({ target: 'project' });
        expect(isWidgetTargetHostableV1(descriptor!, 'project')).toBe(true);
        expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
            v: 1, id: 'automations', definition, bindings: {},
        }, providedContext: {}, viewerValues: {} })).toEqual({ status: 'ready', input: {} });
        const aside = projectOverviewDefaultPlacementsV1().filter(entry => entry.area === 'aside')
            .map(entry => entry.instance.definition.kind === 'builtin' ? entry.instance.definition.id : null);
        expect(aside.indexOf('project_automations')).toBe(aside.indexOf('project_scripts') + 1);
        expect(projectOverviewDefaultPlacementsV1().find(entry => entry.instance.id === 'automations')?.instance.bindings).toEqual({});
    });
    it('admits Home Services without a Session and keeps existing Session copies scoped', () => {
        const definition = { kind: 'builtin', id: 'local_services_app' } as const;
        const app = readBuiltinWidgetDescriptorV1(definition);
        expect(app).toMatchObject({ target: 'app' });
        expect(readWidgetInputTargetV1(app!)).toEqual({ kind: 'app' });
        expect(resolveConfiguredWidgetInputs({ descriptor: app!, instance: { v: 1, id: 'services', definition, bindings: {} },
            providedContext: {}, viewerValues: {} })).toEqual({ status: 'ready', input: {} });
        const session = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'local_services' })!;
        expect(readWidgetInputTargetV1(session)).toEqual({ kind: 'session', path: 'session' });
        expect(resolveConfiguredWidgetInputs({ descriptor: session, instance: { v: 1, id: 'services',
            definition: { kind: 'builtin', id: 'local_services' }, bindings: {} }, providedContext: {}, viewerValues: {} }).status)
            .toBe('selection_required');
    });

    it('names configured breakdown cards consistently for localized UI and headless shared-layout writes', () => {
        const instance = (bindings: WidgetInstanceV1['bindings']): WidgetInstanceV1 => ({ v: 1, id: 'breakdowns',
            definition: { kind: 'builtin', id: 'usage_breakdowns' }, bindings });
        expect(readUsageBreakdownsInstanceTitleV1(instance({ breakdown: { kind: 'value', value: ['model'] } })))
            .toEqual({ title: 'Models', titleKey: 'usage.board.page.dimensionModel' });
        expect(readUsageBreakdownsInstanceTitleV1(instance({ breakdown: { kind: 'value', value: ['agent'] } })))
            .toEqual({ title: 'Agents', titleKey: 'usage.board.page.filterAgents' });
        for (const bindings of [{}, { breakdown: { kind: 'value', value: ['model', 'agent'] } },
            { breakdown: { kind: 'value', value: ['unknown'] } }, { breakdown: { kind: 'context', slot: 'breakdown' } }] satisfies WidgetInstanceV1['bindings'][]) {
            expect(readUsageBreakdownsInstanceTitleV1(instance(bindings))).toBeNull();
        }
        expect(readUsageBreakdownsInstanceTitleV1({ ...instance({ breakdown: { kind: 'value', value: ['model'] } }),
            definition: { kind: 'builtin', id: 'usage_daily' } })).toBeNull();
    });

    it('admits selected planet encodings through the existing own-input binder and public copy schema', () => {
        const variants = [
            ...['ninetyPlanets', 'streakThread', 'weeksSkyline', 'daysOnSurface', 'ringedStreaks', 'aroundPeriod'].map(style => ({ widgetId: 'usage_rhythm', style })),
            { widgetId: 'usage_orbit', style: 'moons' }, { widgetId: 'usage_run_length', style: 'galaxy' },
        ];
        for (const { widgetId, style } of variants) {
            const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: widgetId })!;
            expect(descriptor.inputs?.fields.find(field => field.path === 'style')?.options?.map(option => option.value)).toContain(style);
            expect(resolveConfiguredWidgetInputs({ descriptor, instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: widgetId },
                bindings: { ...proposeWidgetInputDefaultBindingsV1(descriptor), style: { kind: 'value', value: style } } },
                providedContext: {}, viewerValues: {} })).toMatchObject({ status: 'ready', input: { style } });
            expect(BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', widgetId, inputs: { style } }).success).toBe(true);
        }
        for (const id of ['usage_machines', 'usage_projects', 'usage_atmosphere']) {
            expect(readBuiltinWidgetDescriptorV1({ kind: 'builtin', id })).not.toBeNull();
            expect(BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', widgetId: id, inputs: {} }).success).toBe(true);
        }
    });
    it('declares copied public Usage identities and closed own inputs without private query authority', () => {
        for (const widgetId of ['usage_daily', 'usage_period_summary', 'usage_breakdowns', 'usage_outcomes', 'usage_recap',
            'usage_footprint', 'usage_source_coverage', 'usage_orbit', 'usage_planet', 'usage_run_length']) {
            expect(BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', widgetId, inputs: {} }).success).toBe(true);
        }
        expect(BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky', colourBy: 'intensity' } }).success).toBe(true);
        expect(BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', widgetId: 'usage_parallel', inputs: { style: 'peak' } }).success).toBe(true);
        expect(BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', widgetId: 'usage_constellation', inputs: { style: 'agentMix' } }).success).toBe(true);
        for (const value of [
            { widgetId: 'usage_score', inputs: {} }, { widgetId: 'usage_human_loop', inputs: {} },
            { widgetId: 'usage_parallel', inputs: { style: 'lanes' } },
            { widgetId: 'usage_rhythm', inputs: { style: 'sky', colourBy: 'leadingAgent' } },
            ...['metric', 'period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis', 'day', 'resource', 'action'].map(key =>
                ({ widgetId: 'usage_rhythm', inputs: { [key]: key === 'metric' ? 'cost' : 'private' } })),
        ]) expect(BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', ...value }).success).toBe(false);
    });
    it('keeps evidence metrics out of retained accounting-only bodies, including direct binder reads', () => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_period_summary' })!;
        const instance: WidgetInstanceV1 = { v: 1, id: 'summary', definition: { kind: 'builtin', id: 'usage_period_summary' },
            bindings: { ...proposeWidgetInputDefaultBindingsV1(descriptor), metric: { kind: 'value', value: 'busy' } } };
        expect(resolveConfiguredWidgetInputs({ descriptor, instance, providedContext: {}, viewerValues: {} })).toMatchObject({ status: 'invalid' });
    });
    it('declares chart styles as own values, with truthful defaults and conditional Sky colour', () => {
        const rhythm = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_rhythm' })!;
        const parallel = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_parallel' })!;
        const defaults = proposeWidgetInputDefaultBindingsV1(rhythm);
        expect(defaults).toMatchObject({ metric: { kind: 'value', value: 'busy' }, style: { kind: 'value', value: 'heatmap' } });
        expect(proposeWidgetInputDefaultBindingsV1(parallel)).toMatchObject({ style: { kind: 'value', value: 'lanes' } });
        expect(parallel.inputs?.fields.find(field => field.path === 'style')).toMatchObject({ contextMode: 'own', options: [
            { value: 'lanes' }, { value: 'dial' }, { value: 'timeline' },
        ] });
        expect(resolveEffectiveInputFields({ inputHints: rhythm.inputs }, { style: 'sky' }).map(field => field.path)).toContain('colourBy');
        expect(resolveEffectiveInputFields({ inputHints: rhythm.inputs }, { style: 'weekTide' }).map(field => field.path)).not.toContain('colourBy');
        expect(resolveEffectiveInputFields({ inputHints: rhythm.inputs }, { style: 'heatmap' }).map(field => field.path)).not.toContain('metric');
        expect(resolveEffectiveInputFields({ inputHints: rhythm.inputs }, { style: 'sky' }).map(field => field.path)).toContain('metric');
        expect(rhythm.inputs?.fields.filter(field => ['metric', 'style', 'colourBy'].includes(field.path)).every(field => field.contextMode === 'own')).toBe(true);
    });
    it('discovers the five distinct chart questions and materializes Agents preset from descriptor defaults', () => {
        for (const id of ['usage_score', 'usage_orbit', 'usage_constellation', 'usage_planet', 'usage_run_length']) {
            expect(readBuiltinWidgetDescriptorV1({ kind: 'builtin', id })).toMatchObject({ target: 'app' });
        }
        const presets = createUsageWidgetPresets();
        expect(presets.map(preset => preset.id)).toEqual(['overview', 'costs', 'work', 'usage', 'plans', 'coach', 'how-you-work', 'sources', 'agents']);
        const agents = presets.find(preset => preset.id === 'agents')!;
        expect(agents).toBeDefined();
        const children = agents.items.flatMap(item => item.kind === 'group' ? item.children : []);
        expect(children.map(child => child.instance.definition)).toContainEqual({ kind: 'builtin', id: 'usage_score' });
        const crew = children.find(child => child.instance.definition.kind === 'builtin' && child.instance.definition.id === 'usage_breakdowns')!;
        expect(crew.instance.bindings).toMatchObject({ style: { kind: 'value', value: 'crew' },
            period: { kind: 'context', slot: 'period' }, agents: { kind: 'context', slot: 'agents' } });
        expect(crew.instance.bindings.style?.kind === 'value' && crew.instance.bindings.style.value).not.toEqual([]);
        // How you work opens its Sky coloured by the Agent that led each day (owner direction), on busy time.
        const how = presets.find(preset => preset.id === 'how-you-work')!.items.flatMap(item => item.kind === 'group' ? item.children : []);
        const sky = how.find(child => child.instance.definition.kind === 'builtin' && child.instance.definition.id === 'usage_rhythm')!;
        expect(sky.instance.bindings).toMatchObject({ style: { kind: 'value', value: 'sky' }, metric: { kind: 'value', value: 'busy' },
            colourBy: { kind: 'value', value: 'leadingAgent' } });
    });
    it.each(['usage_source_coverage', 'usage_unpriced'])('admits %s with independently bound query scope and no presentation controls', id => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id });
        expect(descriptor).not.toBeNull();
        if (!descriptor) return;
        expect(readWidgetInputTargetV1(descriptor)).toEqual({ kind: 'app' });
        expect(isWidgetTargetHostableV1(descriptor, 'corePage')).toBe(true);
        expect(descriptor.inputs?.fields.map(field => field.path)).toEqual(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']);
        const query = normalizeUsageQuery({ period: { startMs: 1000 }, machines: ['pinned'] });
        const instance: WidgetInstanceV1 = { v: 1, id: 'panel', definition: { kind: 'builtin', id },
            bindings: Object.fromEntries(descriptor.inputs!.fields.map(field => [field.path, { kind: 'value', value: query[field.path as keyof typeof query] ?? null }])) };
        expect(resolveConfiguredWidgetInputs({ descriptor, instance, providedContext: {}, viewerValues: {} }))
            .toMatchObject({ status: 'ready', input: { period: { startMs: 1000 }, machines: ['pinned'] } });
    });
    it('derives machine and root from authorized checkout rows rather than supplied page values', () => {
        const checkout = { serverId: 'home', id: 'checkout', machineId: 'real-machine', rootPath: '/repo', createdAtMs: 0 };
        const input = { value: { ...checkout, rootPath: '/repo/' }, serverId: 'home', workspaceRefs: [checkout] };
        expect(validateWidgetWorkspaceInputV1(input)).toEqual({ status: 'valid', checkout });
        expect(validateWidgetWorkspaceInputV1({ ...input, value: { ...checkout, rootPath: '/other' } })).toMatchObject({ status: 'denied' });
        expect(validateWidgetWorkspaceInputV1({ ...input, value: { ...checkout, machineId: 'forged' } })).toMatchObject({ status: 'denied' });
        expect(validateWidgetWorkspaceInputV1({ ...input, value: { ...checkout, serverId: 'other-home' } })).toMatchObject({ status: 'denied', reasonCode: 'widget_target_scope_mismatch' });
        expect(validateWidgetWorkspaceInputV1({ ...input, workspaceRefs: [] })).toMatchObject({ status: 'denied' });
    });
    it('admits declared targets independently of physical hosting', () => {
        const session = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'session_summary' })!;
        const usage = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_daily' })!;
        expect(isWidgetTargetHostableV1(session, 'corePage')).toBe(true);
        expect(isWidgetTargetHostableV1(usage, 'corePage')).toBe(true);
        const checkout = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' })!;
        for (const surface of ['home', 'project', 'pluginArea', 'workBoard', 'corePage', 'sessionBoard', 'companion']) {
            expect(isWidgetTargetHostableV1(session, surface)).toBe(true);
            expect(isWidgetTargetHostableV1(checkout, surface)).toBe(true);
        }
    });
    it('admits machine widgets with followed qualified machines and per-widget size contracts', () => {
        const four = ['machine_left_behind', 'machine_worktrees', 'machine_cleanup_suggestion'];
        const six = ['machine_vitals', 'machine_fleet', 'machine_metric', 'machine_top_consumers', 'machine_storage', 'machine_guard', 'machine_activity'];
        for (const id of [...four, ...six]) {
            const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id });
            expect(descriptor, id).not.toBeNull();
            if (!descriptor) continue;
            expect(descriptor.sizeDeclaration.sizes).toEqual(four.includes(id) ? ['small', 'medium', 'wide', 'full'] : ['small', 'medium', 'wide', 'full', 'tall', 'large']);
            expect(descriptor.sizeDeclaration.defaultSize).toBe(id === 'machine_fleet' ? 'wide'
                : ['machine_vitals', 'machine_left_behind', 'machine_worktrees'].includes(id) ? 'small' : 'medium');
            expect(readWidgetInputTargetV1(descriptor)).toEqual({ kind: 'app' });
            if (id === 'machine_fleet') {
                expect(descriptor.inputs?.fields.map(field => field.path)).toEqual(['style', 'metrics']);
                expect(resolveConfiguredWidgetInputs({ descriptor, instance: { v: 1, id: 'fleet', definition: { kind: 'builtin', id },
                    bindings: { metrics: { kind: 'value', value: [] } } }, providedContext: {}, viewerValues: {} }))
                    .toMatchObject({ status: 'ready', input: { metrics: [] } });
                continue;
            }
            expect(descriptor.inputs?.fields.find(field => field.path === 'machine')).toMatchObject({ inputType: { hostType: 'machine' }, contextMode: 'follow' });
            const bindings = { machine: { kind: 'context' as const, slot: 'machine' } };
            const options = { descriptor, instance: { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id }, bindings },
                providedContext: { machine: [{ serverId: 'home', machineId: 'm' }] }, viewerValues: {} };
            expect(resolveConfiguredWidgetInputs(options)).toMatchObject({ status: 'ready', input: { machine: { serverId: 'home', machineId: 'm' } } });
            expect(resolveConfiguredWidgetInputs({ ...options, providedContext: { machine: [{ machineId: 'm' }] } }).status).toBe('invalid');
            if (id === 'machine_activity') expect(resolveConfiguredWidgetInputs({ ...options, instance: { ...options.instance, bindings: {} }, providedContext: {} }))
                .toMatchObject({ status: 'ready', input: {} });
            if (id === 'machine_top_consumers') expect(resolveConfiguredWidgetInputs({ ...options, instance: { ...options.instance,
                bindings: { ...bindings, scope: { kind: 'value', value: 'session' } } } }))
                .toMatchObject({ status: 'selection_required', fields: [{ path: 'session' }] });
        }
    });
    it('opens retained nine-path Sources copies and preserves edits of their applicable scope', () => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_sources' })!;
        // The original program preset saved every accounting query path on Sources too.
        const retained: WidgetInstanceV1 = { v: 1, id: 'retained-sources', definition: { kind: 'builtin', id: 'usage_sources' }, bindings: {
            period: { kind: 'context', slot: 'period' }, agents: { kind: 'context', slot: 'agents' },
            machines: { kind: 'value', value: ['pinned'] }, projects: { kind: 'context', slot: 'projects' },
            sources: { kind: 'context', slot: 'sources' }, session: { kind: 'context', slot: 'session' },
            costBasis: { kind: 'context', slot: 'costBasis' }, metric: { kind: 'value', value: 'tokens' },
            breakdown: { kind: 'value', value: [] },
        } };
        const options = { descriptor, instance: retained, providedContext: { agents: [['claude']], sources: [['native']] }, viewerValues: {} };
        expect(resolveConfiguredWidgetInputs(options)).toEqual({ status: 'ready', input: {
            agents: ['claude'], machines: ['pinned'], sources: ['native'],
        } });
        const bindings = setWidgetInputBindingsV1(retained.bindings, {
            agents: { kind: 'value', value: ['codex'] }, machines: { kind: 'value', value: ['edited'] },
            sources: { kind: 'value', value: ['runtime'] },
        }, ['agents', 'machines', 'sources']);
        expect(resolveConfiguredWidgetInputs({ ...options, instance: { ...retained, bindings } })).toEqual({ status: 'ready', input: {
            agents: ['codex'], machines: ['edited'], sources: ['runtime'],
        } });
        expect(resolveConfiguredWidgetInputs({ ...options, instance: { ...retained, bindings: {
            ...retained.bindings, unrelated: { kind: 'value', value: true },
        } } })).toMatchObject({ status: 'invalid', fields: [{ path: 'unrelated', reasonCode: 'widget_input_undeclared' }] });
    });
    it('admits source inventory using only applicable scope fields without a followed period or metric', () => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_sources' })!;
        const instance = { v: 1 as const, id: 'sources', definition: { kind: 'builtin' as const, id: 'usage_sources' }, bindings: {
            agents: { kind: 'context' as const, slot: 'agents' }, machines: { kind: 'value' as const, value: ['pinned'] },
            sources: { kind: 'context' as const, slot: 'sources' },
        } };
        expect(resolveConfiguredWidgetInputs({ descriptor, instance, providedContext: {
            agents: [['claude']], machines: [['page']], sources: [['native']],
        }, viewerValues: {} })).toEqual({ status: 'ready', input: { agents: ['claude'], machines: ['pinned'], sources: ['native'] } });
        expect(descriptor.inputs?.fields.map(field => field.path)).toEqual(['agents', 'machines', 'sources']);
    });
    it('admits real Usage builtins through declared fields, retaining independent scope pins and own presentation', () => {
        const query = normalizeUsageQuery({ period: { startMs: 1000 }, metric: 'cost', breakdown: ['agent'] });
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_flow' });
        expect(descriptor).not.toBeNull();
        if (!descriptor) return;
        expect(readWidgetInputTargetV1(descriptor)).toEqual({ kind: 'app' });
        const context = Object.fromEntries((['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis'] as const)
            .map(path => [path, [query[path]]]));
        const bindings = Object.fromEntries(descriptor.inputs!.fields.filter(field => field.contextMode === 'follow' || field.path === 'metric' || field.path === 'breakdown').map(field => [field.path,
            field.contextMode === 'follow' ? { kind: 'context' as const, slot: field.path }
                : { kind: 'value' as const, value: field.path === 'metric' ? 'cost' : ['agent'] }]));
        const options = { descriptor, instance: { v: 1 as const, id: 'flow', definition: { kind: 'builtin' as const, id: 'usage_flow' }, bindings },
            providedContext: composeWidgetGroupContextV1({ providedContext: context,
                groupBindings: { period: { kind: 'value', value: { startMs: 2000 } } } }), viewerValues: {} };
        expect(resolveConfiguredWidgetTargetInputV1(options)).toMatchObject({ status: 'ready', input: {
            period: { startMs: 2000 }, agents: [], machines: [], projects: [], sources: [], session: null,
            costBasis: 'auto', metric: 'cost', breakdown: ['agent'],
        } });
        expect(resolveConfiguredWidgetInputs({ ...options, providedContext: { ...options.providedContext,
            machines: [['machine']], costBasis: ['reported'] } })).toMatchObject({ status: 'ready', input: {
            period: { startMs: 2000 }, machines: ['machine'], costBasis: 'reported', metric: 'cost', breakdown: ['agent'],
        } });
        expect(resolveConfiguredWidgetInputs({ ...options, instance: { ...options.instance,
            bindings: { ...bindings, period: { kind: 'value', value: { startMs: 3000 } } } },
            providedContext: { ...options.providedContext, machines: [['new-machine']], costBasis: ['estimated'] },
        })).toMatchObject({ status: 'ready', input: {
            period: { startMs: 3000 }, agents: [], machines: ['new-machine'], projects: [], sources: [], session: null,
            costBasis: 'estimated', metric: 'cost', breakdown: ['agent'],
        } });
        expect(resolveConfiguredWidgetInputs({ ...options, instance: { ...options.instance,
            bindings: { ...bindings, metric: { kind: 'context', slot: 'metric' } } },
            providedContext: { ...context, metric: ['tokens'] } }).status).toBe('invalid');
        expect(resolveConfiguredWidgetInputs({ ...options, providedContext: {} }).status).toBe('selection_required');
    });
    it('discovers app-read inputs without inventing a Session or checkout target', () => {
        const descriptor: WidgetInputDescriptorV1 = { inputs: { fields: [{ path: 'period', title: 'Period', widget: 'integer', required: true }] },
            inputSchema: { type: 'object', properties: { period: { type: 'integer' } }, required: ['period'], additionalProperties: false } };
        const options = { descriptor, instance: { v: 1 as const, id: 'usage-copy', definition: { kind: 'builtin' as const, id: 'app-read-fixture' },
            bindings: { period: { kind: 'value' as const, value: 7 } } }, providedContext: {}, viewerValues: {} };
        expect(resolveConfiguredWidgetTargetInputV1(options)).toEqual({ status: 'ready', input: { period: 7 } });
        expect(resolveConfiguredWidgetInputs({ ...options, validateValue: () => ({ status: 'denied', reasonCode: 'read_retired' }) }))
            .toMatchObject({ status: 'denied', fields: [{ path: 'period', reasonCode: 'read_retired' }] });
        expect(resolveConfiguredWidgetInputs({ ...options, instance: { ...options.instance, bindings: { period: { kind: 'value', value: 'invalid' } } } }).status)
            .toBe('invalid');
    });

    it('discovers exact native targets from declared shared field types with independent field paths', () => {
        const session = { serverId: 'home', sessionId: 'B' };
        const descriptor = { inputs: { fields: [{ path: 'source', title: 'Session', widget: 'json' as const, inputType: { hostType: 'session' as const }, required: true }] } };
        expect(readWidgetInputTargetV1(descriptor)).toEqual({ kind: 'session', path: 'source' });
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'session-fixture' },
            bindings: { source: { kind: 'value' as const, value: session } } };
        expect(resolveConfiguredWidgetTargetInputV1({ instance, descriptor, providedContext: {}, viewerValues: {} }))
            .toEqual({ status: 'ready', input: { source: session } });
        expect(resolveConfiguredWidgetTargetInputV1({ instance: { ...instance, bindings: {} }, descriptor, providedContext: {}, viewerValues: {} }).status)
            .toBe('selection_required');
    });
    it('admits Project bodies with an exact checkout without requiring a saved Source or Session', () => {
        const checkout = { serverId: 'home', id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
        for (const id of ['project_about', 'project_code', 'project_readme', 'project_checkouts', 'project_scripts', 'project_sessions', 'project_changes']) {
            const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id });
            expect(descriptor).toMatchObject({ target: 'app', inputs: { fields: [{ path: 'checkout', inputType: { hostType: 'workspace' } }] } });
            expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
                v: 1, id: 'copy', definition: { kind: 'builtin', id }, bindings: { checkout: { kind: 'context', slot: 'checkout' } },
            }, providedContext: { checkout: [checkout], project: [] }, viewerValues: {} })).toEqual({ status: 'ready', input: { checkout } });
        }
    });

    it('refuses incomplete checkout inputs and preserves the Session-only native contracts', () => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' });
        expect(descriptor).not.toBeNull();
        expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
            v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_code' }, bindings: { checkout: { kind: 'value', value: { rootPath: '/repo' } } },
        }, providedContext: {}, viewerValues: {} }).status).toBe('invalid');
        for (const id of SESSION_COMPANION_BUILTIN_ITEM_IDS) expect(readBuiltinWidgetDescriptorV1({ kind: 'builtin', id }))
            .toMatchObject({ target: 'session', inputs: { fields: [{ path: 'session', inputType: { hostType: 'session' } }] } });
    });

    it('admits a pinned real WorkspaceRef with additive Project facts, without making them checkout authority', () => {
        const checkout = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
            projectKey: 'stable-project', label: 'My checkout', source: { sourceId: 'source', revision: 2 } };
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' });
        expect(resolveConfiguredWidgetInputs({ descriptor: descriptor!, instance: {
            v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_code' }, bindings: { checkout: { kind: 'value', value: checkout } },
        }, providedContext: {}, viewerValues: {} })).toEqual({ status: 'ready', input: { checkout } });
    });
});

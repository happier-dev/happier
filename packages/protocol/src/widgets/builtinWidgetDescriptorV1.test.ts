import { describe, expect, it } from 'vitest';
import { readBuiltinWidgetDescriptorV1, SESSION_COMPANION_BUILTIN_ITEM_IDS } from './builtinWidgetDescriptorV1.js';
import { readWidgetInputTargetV1, resolveConfiguredWidgetInputs, resolveConfiguredWidgetTargetInputV1, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import { composeWidgetGroupContextV1 } from './widgetActionInputResolverV1.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { setWidgetInputBindingsV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';

describe('native widget target contracts', () => {
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
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_daily' });
        expect(descriptor).not.toBeNull();
        if (!descriptor) return;
        expect(readWidgetInputTargetV1(descriptor)).toEqual({ kind: 'app' });
        const context = Object.fromEntries((['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis'] as const)
            .map(path => [path, [query[path]]]));
        const bindings = Object.fromEntries(descriptor.inputs!.fields.map(field => [field.path,
            field.contextMode === 'follow' ? { kind: 'context' as const, slot: field.path }
                : { kind: 'value' as const, value: field.path === 'metric' ? 'cost' : ['agent'] }]));
        const options = { descriptor, instance: { v: 1 as const, id: 'daily', definition: { kind: 'builtin' as const, id: 'usage_daily' }, bindings },
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

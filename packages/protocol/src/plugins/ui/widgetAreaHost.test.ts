import { describe, expect, it } from 'vitest';
import { createPluginWidgetAreaHostPortV1 } from './widgetAreaHost.js';
import { createWorkBoardArtifactBoundary } from '../../boards/workBoardArtifactV1.testkit.js';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetAreaLayoutArtifactPortV1, WidgetAreaPresetResultV1Schema } from '../../widgets/widgetSurfaceArtifactV1.js';
import { createWidgetActionInputResolverV1 } from '../../widgets/widgetActionInputResolverV1.js';
import { createActionExecutor, type ActionExecutorDeps } from '../../actions/actionExecutor.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaOperationV1Schema } from './widgetArea.js';
import { flattenWidgetLayoutWidgetsV1 } from '../../widgets/widgetLayoutItemV1.js';
import type { WidgetSurfaceRefV1 } from '../../widgets/widgetInstanceV1.js';

const scope = { serverId: 'home', accountId: 'viewer' };
const instance = { v: 1 as const, id: 'follow', definition: { kind: 'builtin' as const, id: 'counter' }, bindings: { count: { kind: 'context' as const, slot: 'count' } } };
const declarations = [{ name: 'pinned', contextSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }];
describe('mounted area operations through the canonical Action/Artifact/binder owners', () => {
    it('places layout selection on the answering client as a presentation effect', () => {
        const spec = getActionSpec('widgets.area.layout.select');
        const surface = { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        expect(spec.executionPlacementForInput?.({ surface }) ?? spec.executionPlacement).toBe('client');
        expect(spec.sideEffectClass).toBe('write');
        expect(spec.safety).toBe('safe');
    });
    it('carries named-layout operations inside the declared page area and refuses nested foreign identity', async () => {
        const observed: { id: string; input: unknown }[] = [];
        const revision = { headerVersion: 2, bodyVersion: 2 };
        const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId: 'overview', declarations,
            isCurrent: () => true, execute: async (id, input) => { observed.push({ id, input }); return { ok: false, errorCode: 'fixture_refusal', error: 'fixture_refusal' }; } });
        for (const operation of [
            { actionId: 'widgets.area.layout.list' },
            { actionId: 'widgets.area.layout.create', layoutId: 'new', name: 'New', fromLayoutId: 'mine' },
            { actionId: 'widgets.area.layout.select', layoutId: 'mine' },
            { actionId: 'widgets.area.layout.rename', name: 'Renamed', expectedRevision: revision },
            { actionId: 'widgets.area.layout.reorder', position: { anchorId: 'other', placement: 'before' }, expectedRevision: revision },
            { actionId: 'widgets.area.layout.delete', expectedRevision: revision },
            { actionId: 'widgets.area.layout.reset', expectedRevision: revision },
            { actionId: 'widgets.area.layout.undo', capture: { layoutId: 'mine', expectedRevision: revision,
                previousLayout: { v: 1, name: 'Before', items: [] } } },
        ]) {
            expect(await port.execute({ area: 'pinned', layoutId: 'mine', context: { count: 1 }, operation })).toMatchObject({ errorCode: 'fixture_refusal' });
        }
        expect(observed).toHaveLength(8);
        expect(observed[2]).toMatchObject({ id: 'widgets.area.layout.select', input: { surface: { ...scope,
            owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned', layoutId: 'mine' } } } });
        expect(observed[1]).toMatchObject({ input: { fromSurface: { ...scope,
            owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned', layoutId: 'mine' } } } });
        expect(observed[7]).toMatchObject({ input: { capture: {
            surface: { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned', layoutId: 'mine' } },
            previousLayout: { surface: { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned', layoutId: 'mine' } } },
        } } });
        const foreign = { serverId: 'another-home', accountId: 'someone-else', owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
        for (const operation of [
            { actionId: 'widgets.area.layout.create', layoutId: 'new', name: 'New', fromSurface: foreign },
            { actionId: 'widgets.area.layout.undo', capture: { layoutId: 'mine', surface: foreign, expectedRevision: revision, previousLayout: { v: 1, items: [] } } },
            { actionId: 'widgets.area.layout.undo', capture: { layoutId: 'mine', expectedRevision: revision, previousLayout: { v: 1, surface: foreign, items: [] } } },
        ]) expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation })).toMatchObject({ ok: false, errorCode: 'invalid_widget_area_request' });
        expect(observed).toHaveLength(8);
    });
    it('creates and edits a group through host-captured scope without admitting forged identities', async () => {
        const b = createWorkBoardArtifactBoundary();
        const transport = { ...b.transport, read: async (id: string) => {
            const row = await b.transport.read(id); return row ? { ...row, ownerAccountId: scope.accountId } : null;
        } };
        const surface = { ...scope, owner: { kind: 'pluginArea' as const, pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        const store = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
        await store.apply({ kind: 'add', instance, size: 'small' });
        const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
        const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area } });
        const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId: 'overview', declarations, isCurrent: () => true,
            execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
        for (const operation of [
            { actionId: 'widgets.group.create', groupId: 'g', instanceIds: ['follow'] },
            { actionId: 'widgets.item.rename', instanceId: 'g', displayName: 'Together' },
            { actionId: 'widgets.item.size.set', instanceId: 'g', width: 'half' },
            { actionId: 'widgets.group.set', instanceId: 'g', dividers: 'none' },
            { actionId: 'widgets.group.inputs.set', instanceId: 'g', bindings: { count: { kind: 'value', value: 7 } } },
        ]) expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation })).toMatchObject({ ok: true });
        expect((await store.read()).items).toMatchObject([{ kind: 'group', id: 'g', title: 'Together', width: 'half', dividers: 'none', context: { count: { value: 7 } } }]);
        expect(PluginUiWidgetAreaOperationV1Schema.safeParse({ actionId: 'widgets.group.create', groupId: 'forged', instanceIds: ['follow'], surface }).success).toBe(false);
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.group.ungroup', instanceId: 'g' } })).toMatchObject({ ok: true });
        expect((await store.read()).items).toMatchObject([{ kind: 'widget', instance: { id: 'follow' } }]);
    });
    it('undo restores its captured named layout even when another layout is currently requested', async () => {
        const b = createWorkBoardArtifactBoundary();
        const transport = { ...b.forAccount(scope.accountId), list: b.transport.list!, delete: b.transport.delete! };
        const base = { ...scope, owner: { kind: 'pluginArea' as const, pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        const mine = { ...base, owner: { ...base.owner, layoutId: 'mine' } };
        const other = { ...base, owner: { ...base.owner, layoutId: 'other' } };
        const presets = [{ id: 'mine', name: 'Mine', items: [] }, { id: 'other', name: 'Other', items: [] }];
        const store = (surface: WidgetSurfaceRefV1) => createWidgetSurfaceArtifactPortV1(transport, { surface, presets, isCurrent: () => true });
        await store(mine).apply({ kind: 'add', instance });
        await store(other).apply({ kind: 'add', instance: { ...instance, id: 'other-child' } });
        const before = await store(mine).readState();
        if (before.kind !== 'present') throw new Error('Expected the acknowledged named layout');
        const layouts = createWidgetAreaLayoutArtifactPortV1(transport, { surface: base, presets, isCurrent: () => true });
        const executor = createActionExecutor({ widgetAccountScope: () => scope,
            widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(store) },
            widgetAreaLayouts: {
                list: (_args, _context, signal) => layouts.list(signal),
                create: (args, _context, signal) => layouts.create(args, signal),
                rename: (args, _context, signal) => layouts.rename(args, signal),
                reorder: (args, _context, signal) => layouts.reorder(args, signal),
                delete: (args, _context, signal) => layouts.delete(args, signal),
                reset: (args, _context, signal) => store(args.surface).resetPreset(args.expectedRevision, signal),
                undo: (capture, _context, signal) => store(capture.surface).undoReset(capture, signal),
            } });
        const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId: 'overview', declarations, isCurrent: () => true,
            execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
        const reset = await port.execute({ area: 'pinned', layoutId: 'mine', context: { count: 1 },
            operation: { actionId: 'widgets.area.layout.reset', expectedRevision: before.revision } });
        expect(reset).toMatchObject({ ok: true, result: { layout: { items: [] } } });
        if (!reset.ok) throw new Error(reset.errorCode);
        const capture = WidgetAreaPresetResultV1Schema.parse(reset.result).undo!;
        const { surface: _surface, ...previousLayout } = capture.previousLayout;
        expect(await port.execute({ area: 'pinned', layoutId: 'other', context: { count: 1 }, operation: {
            actionId: 'widgets.area.layout.undo', capture: { layoutId: 'mine', previousLayout, expectedRevision: capture.expectedRevision },
        } })).toMatchObject({ ok: true });
        expect((await store(mine).read()).items).toMatchObject([{ instance: { id: 'follow' } }]);
        expect((await store(other).read()).items).toMatchObject([{ instance: { id: 'other-child' } }]);
    });
    it('adds a widget straight into a group slot through the area\'s add operation', async () => {
        const b = createWorkBoardArtifactBoundary();
        const transport = { ...b.transport, read: async (id: string) => {
            const row = await b.transport.read(id); return row ? { ...row, ownerAccountId: scope.accountId } : null;
        } };
        const surface = { ...scope, owner: { kind: 'pluginArea' as const, pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        const store = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
        await store.apply({ kind: 'add', instance, size: 'small' });
        const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
        // The descriptor is an external boundary; size and input admission remain real.
        const widgetInputs = createWidgetActionInputResolverV1({
            readDescriptor: async () => ({ sizeDeclaration: { sizes: ['small'], defaultSize: 'small' },
                inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer', required: true }] },
                inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }),
            readContext: async request => request.context.widgetAreaContext?.values ?? {}, readViewerValues: async () => ({ values: {} }),
            validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
        });
        const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area }, widgetInputs });
        const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId: 'overview', declarations, isCurrent: () => true,
            execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.group.create', groupId: 'g', instanceIds: ['follow'] } })).toMatchObject({ ok: true });
        const second = { ...instance, id: 'second' };
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.item.add', instance: second, groupId: 'g' } })).toMatchObject({ ok: true });
        expect((await store.read()).items).toMatchObject([{ kind: 'group', id: 'g', children: [{ instance: { id: 'follow' } }, { instance: { id: 'second' } }] }]);
    });
    it('projects both widget size and group width without mixing their mutation fields', () => {
        const surface = { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        for (const sizing of [{ size: 'wide' }, { width: 'half' }]) {
            const operation = PluginUiWidgetAreaOperationV1Schema.parse({ actionId: 'widgets.item.size.set', instanceId: 'item', ...sizing });
            const input = buildWidgetAreaActionInputV1(operation, surface);
            expect(getActionSpec(operation.actionId).inputSchema.parse(input)).toEqual(input);
        }
        expect(PluginUiWidgetAreaOperationV1Schema.safeParse({
            actionId: 'widgets.item.size.set', instanceId: 'item', size: 'wide', width: 'half',
        }).success).toBe(false);
    });
    it('carries an explicit Project area move through the same semantic operation and Artifact owner', async () => {
        const b = createWorkBoardArtifactBoundary();
        const transport = { ...b.transport, read: async (id: string) => {
            const row = await b.transport.read(id); return row ? { ...row, ownerAccountId: scope.accountId } : null;
        } };
        const surface = { ...scope, owner: { kind: 'project' as const, projectId: 'anchor' } };
        const store = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
        await store.apply({ kind: 'add', instance, area: 'main' });
        const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
        const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { project: area } });
        const operation = PluginUiWidgetAreaOperationV1Schema.parse({ actionId: 'widgets.item.move', instanceId: instance.id, toIndex: 0, area: 'aside' });
        expect(await executor.execute(operation.actionId, buildWidgetAreaActionInputV1(operation, surface), { surface: 'ui', bypassApprovals: true })).toMatchObject({ ok: true });
        expect(flattenWidgetLayoutWidgetsV1((await store.read()).items).find(entry => entry.instance.id === instance.id)).toMatchObject({ area: 'aside' });
        expect(b.rows.size).toBe(1);
    });
    it('retains a durable area edit acknowledgement when retirement follows the write', async () => {
        const b = createWorkBoardArtifactBoundary();
        let current = true;
        let retireAfterWrite = false;
        const transport = { ...b.transport,
            read: async (id: string) => { const row = await b.transport.read(id); return row ? { ...row, ownerAccountId: scope.accountId } : null; },
            update: async (input: Parameters<typeof b.transport.update>[0]) => { const result = await b.transport.update(input); if (retireAfterWrite) current = false; return result; },
        };
        const surface = { ...scope, owner: { kind: 'pluginArea' as const, pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => current }));
        await createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => current }).apply({ kind: 'add', instance });
        const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area } });
        const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId: 'overview', declarations, isCurrent: () => current,
            execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
        retireAfterWrite = true;
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.item.rename', instanceId: 'follow', displayName: 'Saved' } }))
            .toMatchObject({ ok: true, result: { instance: { displayName: 'Saved' } } });
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.item.list' } }))
            .toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
    });
    it('adds two independent copies, edits layout/inputs and rebinds following context without changing a pin', async () => {
        const b = createWorkBoardArtifactBoundary();
        const transport = { ...b.transport, read: async (id: string) => { const row = await b.transport.read(id); return row ? { ...row, ownerAccountId: scope.accountId } : null; } };
        const area = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true }));
        const widgetInputs = createWidgetActionInputResolverV1({
            readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium', 'full', 'tall'], defaultSize: 'medium' }, inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer', required: true }] },
                inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }),
            readContext: async request => request.context.widgetAreaContext?.values ?? {}, readViewerValues: async () => ({ values: {} }),
            validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
        });
        // Only external descriptor and persistence boundaries are supplied; Actions, schema, binder and reducer stay real.
        const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area }, widgetInputs } as ActionExecutorDeps);
        const page = (pageId: string) => createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId, declarations, isCurrent: () => true,
            execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
        const port = page('overview');
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.item.add', instance } })).toMatchObject({ ok: true });
        const pin = { ...instance, id: 'pin', bindings: { count: { kind: 'value', value: 8 } } };
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.item.add', instance: pin } })).toMatchObject({ ok: true });
        expect(await port.execute({ area: 'pinned', context: { count: 5 }, operation: { actionId: 'widgets.item.inputs.validate', instanceId: 'follow', bindings: instance.bindings } })).toEqual({ ok: true, result: { status: 'ready', input: { count: 5 } } });
        expect(await port.execute({ area: 'pinned', context: { count: 5 }, operation: { actionId: 'widgets.item.inputs.validate', instanceId: 'pin', bindings: pin.bindings } })).toEqual({ ok: true, result: { status: 'ready', input: { count: 8 } } });
        for (const operation of [
            { actionId: 'widgets.item.size.set', instanceId: 'pin', size: 'full' },
            { actionId: 'widgets.item.frame.set', instanceId: 'pin', frameStyle: 'card' },
            { actionId: 'widgets.item.move', instanceId: 'pin', toIndex: 0 },
            { actionId: 'widgets.item.inputs.set', instanceId: 'follow', bindings: { count: { kind: 'value', value: 9 } } },
        ]) expect(await port.execute({ area: 'pinned', context: { count: 5 }, operation })).toMatchObject({ ok: true });
        const reloaded = await page('overview').execute({ area: 'pinned', context: { count: 5 }, operation: { actionId: 'widgets.item.list' } });
        expect(reloaded).toMatchObject({ ok: true, result: { surface: { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } }, instances: [
            { instance: pin, size: 'full', frameStyle: 'card' }, { instance: { ...instance, bindings: { count: { kind: 'value', value: 9 } } } },
        ] } });
        expect(await page('another').execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.item.list' } })).toMatchObject({ ok: true, result: { instances: [] } });
        const surface = { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        expect(await executor.execute('widgets.item.move', { ref: { surface, instanceId: 'follow' }, toIndex: 0 }, { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.list', { surface }, { surface: 'mcp' })).toMatchObject({ ok: true, result: { instances: [{ instance: { id: 'follow' } }, { instance: { id: 'pin' } }] } });
        expect(getActionSpec('widgets.item.move')).toMatchObject({ safety: 'danger', executionPlacement: 'account' });
    });
    it('refuses undeclared areas, invalid contexts, forged scope and retired callbacks before effects', async () => {
        let current = true;
        let effects = 0;
        const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId: 'overview', declarations, isCurrent: () => current,
            execute: async () => { effects++; return { ok: false, errorCode: 'unavailable', error: 'unavailable' }; } });
        const request = { area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.item.list' } };
        expect(await port.execute({ ...request, accountId: 'other' })).toMatchObject({ ok: false, errorCode: 'invalid_widget_area_request' });
        expect(await port.execute({ ...request, area: 'invented' })).toMatchObject({ ok: false, errorCode: 'widget_area_not_declared' });
        expect(await port.execute({ ...request, context: { count: 'wrong' } })).toMatchObject({ ok: false, errorCode: 'widget_area_context_invalid' });
        current = false;
        expect(await port.execute(request)).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
        expect(effects).toBe(0);
    });
});

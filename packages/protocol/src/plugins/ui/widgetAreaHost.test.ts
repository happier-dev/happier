import { describe, expect, it } from 'vitest';
import { createPluginWidgetAreaHostPortV1 } from './widgetAreaHost.js';
import { createWorkBoardArtifactBoundary } from '../../boards/workBoardArtifactV1.testkit.js';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1 } from '../../widgets/widgetSurfaceArtifactV1.js';
import { createWidgetActionInputResolverV1 } from '../../widgets/widgetActionInputResolverV1.js';
import { createActionExecutor, type ActionExecutorDeps } from '../../actions/actionExecutor.js';
import { getActionSpec } from '../../actions/actionSpecs.js';

const scope = { serverId: 'home', accountId: 'viewer' };
const instance = { v: 1 as const, id: 'follow', definition: { kind: 'builtin' as const, id: 'counter' }, bindings: { count: { kind: 'context' as const, slot: 'count' } } };
const declarations = [{ name: 'pinned', contextSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }];
describe('mounted area operations through the canonical Action/Artifact/binder owners', () => {
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
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.instance.rename', instanceId: 'follow', displayName: 'Saved' } }))
            .toMatchObject({ ok: true, result: { instance: { displayName: 'Saved' } } });
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.instance.list' } }))
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
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.instance.add', instance } })).toMatchObject({ ok: true });
        const pin = { ...instance, id: 'pin', bindings: { count: { kind: 'value', value: 8 } } };
        expect(await port.execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.instance.add', instance: pin } })).toMatchObject({ ok: true });
        expect(await port.execute({ area: 'pinned', context: { count: 5 }, operation: { actionId: 'widgets.instance.inputs.validate', instanceId: 'follow', bindings: instance.bindings } })).toEqual({ ok: true, result: { status: 'ready', input: { count: 5 } } });
        expect(await port.execute({ area: 'pinned', context: { count: 5 }, operation: { actionId: 'widgets.instance.inputs.validate', instanceId: 'pin', bindings: pin.bindings } })).toEqual({ ok: true, result: { status: 'ready', input: { count: 8 } } });
        for (const operation of [
            { actionId: 'widgets.instance.size.set', instanceId: 'pin', size: 'full' },
            { actionId: 'widgets.instance.frame.set', instanceId: 'pin', frameStyle: 'card' },
            { actionId: 'widgets.instance.move', instanceId: 'pin', toIndex: 0 },
            { actionId: 'widgets.instance.inputs.set', instanceId: 'follow', bindings: { count: { kind: 'value', value: 9 } } },
        ]) expect(await port.execute({ area: 'pinned', context: { count: 5 }, operation })).toMatchObject({ ok: true });
        const reloaded = await page('overview').execute({ area: 'pinned', context: { count: 5 }, operation: { actionId: 'widgets.instance.list' } });
        expect(reloaded).toMatchObject({ ok: true, result: { surface: { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } }, instances: [
            { instance: pin, size: 'full', frameStyle: 'card' }, { instance: { ...instance, bindings: { count: { kind: 'value', value: 9 } } } },
        ] } });
        expect(await page('another').execute({ area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.instance.list' } })).toMatchObject({ ok: true, result: { instances: [] } });
        const surface = { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } };
        expect(await executor.execute('widgets.area.layout.update', { surface, intent: { kind: 'move', instanceId: 'follow', toIndex: 0 } }, { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.area.layout.get', { surface }, { surface: 'mcp' })).toMatchObject({ ok: true, result: { instances: [{ instance: { id: 'follow' } }, { instance: { id: 'pin' } }] } });
        expect(getActionSpec('widgets.area.layout.update')).toMatchObject({ safety: 'danger', executionPlacement: 'account' });
    });
    it('refuses undeclared areas, invalid contexts, forged scope and retired callbacks before effects', async () => {
        let current = true;
        let effects = 0;
        const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: 'example', pageId: 'overview', declarations, isCurrent: () => current,
            execute: async () => { effects++; return { ok: false, errorCode: 'unavailable', error: 'unavailable' }; } });
        const request = { area: 'pinned', context: { count: 1 }, operation: { actionId: 'widgets.instance.list' } };
        expect(await port.execute({ ...request, accountId: 'other' })).toMatchObject({ ok: false, errorCode: 'invalid_widget_area_request' });
        expect(await port.execute({ ...request, area: 'invented' })).toMatchObject({ ok: false, errorCode: 'widget_area_not_declared' });
        expect(await port.execute({ ...request, context: { count: 'wrong' } })).toMatchObject({ ok: false, errorCode: 'widget_area_context_invalid' });
        current = false;
        expect(await port.execute(request)).toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
        expect(effects).toBe(0);
    });
});

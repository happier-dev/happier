import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createPluginWidgetAreaHostPortV1 } from '@happier-dev/protocol/plugins/ui';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { widgetAreasPlugin, runWidgetAreaExample } from '../../examples/widget-areas/index.js';
import { createPluginTestkit } from './host.js';
import { createPluginUiTestkit } from './uiHost.js';
import { createSurfaceContextFixture } from '../ui/surfaceContext.fixture.js';

it('activates a real declared plugin and runs area inputs/layout/refresh through the public SDK client and host port', async () => {
    const plugin = await createPluginTestkit({ manifest: widgetAreasPlugin.manifest, module: widgetAreasPlugin });
    const scope = { serverId: 'home', accountId: 'viewer' };
    const rows = new Map<string, NonNullable<Awaited<ReturnType<HomeHubArtifactTransportV1['read']>>>>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => { rows.set(input.artifactId, { ...input, ownerAccountId: scope.accountId, revision: { headerVersion: 1, bodyVersion: 1 } }); },
        update: async input => { const revision = { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 };
            rows.set(input.artifactId, { ...input, ownerAccountId: scope.accountId, revision }); return { ok: true, revision }; },
    };
    const page = widgetAreasPlugin.manifest.contributes?.ui?.views?.find(view => view.id === 'overview');
    const widget = widgetAreasPlugin.manifest.contributes?.ui?.views?.find(view => view.id === 'counter');
    if (!page || page.container !== 'appPage' || !page.widgetAreas || !widget || widget.container !== 'widget') throw new Error('Registered declarations missing');
    const area = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true }));
    const deps = { widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area },
        widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => widget,
            readContext: async request => request.context.widgetAreaContext?.values ?? {}, readViewerValues: async () => ({ values: {} }),
            validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    } satisfies Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetSurfaceActions' | 'widgetInputs'>;
    // This Artifact-boundary fixture supplies only the external ports reached by widget-area Actions.
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: widgetAreasPlugin.manifest.id, pageId: page.id,
        declarations: page.widgetAreas, isCurrent: () => true, execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }) });
    const fixture = await createPluginUiTestkit({ authorPlugin: { id: widgetAreasPlugin.manifest.id, version: '1.0.0' },
        identity: { instanceId: 'area-test', mountNonce: 'area-mount' }, surface: {}, surfaceContext: createSurfaceContextFixture(),
        adapter: { mount: async () => ({ snapshot: async () => ({ revision: 1, nodes: [] }), update: async () => {}, invoke: async () => {}, dispose: async () => {} }) },
        handlers: { widgetArea: ({ request, signal }) => port.execute(request, signal) },
    });
    try {
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: widgetAreasPlugin.manifest.id, localId: widget.id } },
            bindings: { filter: { kind: 'context' as const, slot: 'filter' } } };
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.instance.add', instance })).toMatchObject({ ok: true });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.instance.inputs.validate', instanceId: 'copy', bindings: instance.bindings }, 'closed'))
            .toEqual({ ok: true, result: { status: 'ready', input: { filter: 'closed' } } });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.instance.width.set', instanceId: 'copy', width: 'full' })).toMatchObject({ ok: true });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.instance.move', instanceId: 'copy', toIndex: 0 })).toMatchObject({ ok: true });
        // A headless SDK fixture has no UI contextual Resource store. Exercise
        // its real refusal, never install a second refresh implementation.
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.instance.refresh', instanceId: 'copy' }))
            .toMatchObject({ ok: false, errorCode: 'widget_refresh_unavailable' });
        const resource = plugin.registration('resources', 'count');
        if (!resource) throw new Error('Resource registration missing');
        const bytes = await resource.read({ context: { kind: 'global' }, signal: new AbortController().signal });
        expect(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))).toEqual({ count: 42 });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.instance.list' })).toMatchObject({ ok: true, result: { instances: [{ instance, width: 'full' }] } });
    } finally { await fixture.dispose(); await plugin.dispose(); }
});

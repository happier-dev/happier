import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const directory = await mkdtemp(join(tmpdir(), 'happier-widget-area-'));
    await writeFile(join(directory, 'first.txt'), 'first');
    await writeFile(join(directory, 'second.txt'), 'second');
    await mkdir(join(directory, 'child'));
    const scope = { serverId: 'home', accountId: 'viewer' };
    const rows = new Map<string, NonNullable<Awaited<ReturnType<HomeHubArtifactTransportV1['read']>>>>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => { const row = { ...input, ownerAccountId: scope.accountId, revision: { headerVersion: 1, bodyVersion: 1 } };
            if (!rows.has(input.artifactId)) rows.set(input.artifactId, row); return rows.get(input.artifactId)!; },
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
        const resource = plugin.registration('resources', 'count');
        if (!resource) throw new Error('Resource registration missing');
        const read = async (filter: string) => {
            const bytes = await resource.read({ context: { kind: 'surface', mountInstanceKey: 'area-test',
                launchInput: { directory, filter } }, signal: new AbortController().signal });
            return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
        };
        expect(await read('files')).toEqual({ directory, filter: 'files', count: 2 });
        expect(await read('folders')).toEqual({ directory, filter: 'folders', count: 1 });
        let invalidate: () => void = () => {};
        const invalidated = new Promise<void>(resolve => { invalidate = resolve; });
        const observer = resource.observe(invalidate, { context: { kind: 'surface', mountInstanceKey: 'area-test',
            launchInput: { directory, filter: 'files' } }, signal: new AbortController().signal });
        try {
            await writeFile(join(directory, 'third.txt'), 'third');
            await invalidated;
        } finally { observer.dispose(); }
        expect(await read('files')).toEqual({ directory, filter: 'files', count: 3 });
        await expect(resource.read({ context: { kind: 'surface', mountInstanceKey: 'area-test',
            launchInput: { directory: join(directory, 'missing'), filter: 'files' } }, signal: new AbortController().signal }))
            .rejects.toMatchObject({ code: 'ENOENT' });
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: widgetAreasPlugin.manifest.id, localId: widget.id } },
            bindings: { directory: { kind: 'context' as const, slot: 'directory' }, filter: { kind: 'context' as const, slot: 'filter' } } };
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.item.add', instance }, 'files', directory)).toMatchObject({ ok: true });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.item.inputs.validate', instanceId: 'copy', bindings: instance.bindings }, 'folders', directory))
            .toEqual({ ok: true, result: { status: 'ready', input: { directory, filter: 'folders' } } });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.item.size.set', instanceId: 'copy', size: 'full' })).toMatchObject({ ok: true });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.item.move', instanceId: 'copy', toIndex: 0 })).toMatchObject({ ok: true });
        // A headless SDK fixture has no UI contextual Resource store. Exercise
        // its real refusal, never install a second refresh implementation.
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.item.refresh', instanceId: 'copy' }))
            .toMatchObject({ ok: false, errorCode: 'widget_refresh_unavailable' });
        expect(await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.item.list' })).toMatchObject({ ok: true, result: { instances: [{ instance, size: 'full' }] } });
    } finally { await fixture.dispose(); await plugin.dispose(); await rm(directory, { recursive: true, force: true }); }
});

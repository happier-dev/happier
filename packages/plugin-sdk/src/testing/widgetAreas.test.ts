import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '../../../tests/src/testkit/actionExecutorBoundary.js';
import { createPluginWidgetAreaHostPortV1 } from '@happier-dev/protocol/plugins/ui';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '../../../protocol/src/boards/workBoardArtifactV1.testkit.js';
import { widgetAreasPlugin, runWidgetAreaExample } from '../../examples/widget-areas/index.js';
import { createPluginTestkit } from './host.js';
import { createPluginUiTestkit } from './uiHost.js';
import { createSurfaceContextFixture } from '../ui/surfaceContext.fixture.js';
import { createPluginRegistrationScope } from '../registration/scope.js';
import { derivePluginClientContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { projectWidgetSnapshotPreviewV1 } from '@happier-dev/protocol/widgets';
import { definePluginDeclarativeDocumentV1 } from '../ui/declarativeDocument.js';
import { activate as activateEntities, inspectDrop } from '../../examples/widget-areas/ui/entity-drag-drop.js';
import { inspectedItemSchema } from '../../examples/widget-areas/entityContract.js';

it('publishes a widget input type and reads its declared options through the real plugin registration', async () => {
    const inputType = widgetAreasPlugin.manifest.contributes?.inputTypes?.find(type => type.id === 'count-kind');
    expect(inputType).toMatchObject({ semantic: 'directory-count-kind',
        valueSchema: { type: 'string', enum: ['files', 'folders'] }, options: { resource: 'count-kinds' } });
    const widget = widgetAreasPlugin.manifest.contributes?.ui?.views?.find(view => view.id === 'counter');
    if (!widget || widget.container !== 'widget') throw new Error('Declared counter widget is missing');
    expect(widget.inputs?.fields.find(field => field.path === 'filter')?.inputType)
        .toEqual({ pluginId: 'examples.widget-areas', localId: 'count-kind' });
    const resourceId = inputType?.options?.resource;
    if (typeof resourceId !== 'string') throw new Error('Expected a plugin-local options Resource');
    const plugin = await createPluginTestkit({ manifest: widgetAreasPlugin.manifest, module: widgetAreasPlugin });
    try {
        const resource = plugin.registration('resources', resourceId);
        if (!resource) throw new Error('Declared count-kind options Resource is not registered');
        const bytes = await resource.read(createTestResourceInvocationContext({ context: { kind: 'global' }, signal: new AbortController().signal }));
        expect(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))).toEqual([
            { value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' },
        ]);
    } finally { await plugin.dispose(); }
});

it('offers typed entity sources and targets and a Resource-backed declarative widget for snapshot publication', async () => {
    const contributions = widgetAreasPlugin.manifest.contributes;
    expect(contributions?.dragSources?.find(source => source.id === 'sample-card')).toMatchObject({
        referenceSchema: { type: 'object', required: ['id', 'title'], additionalProperties: false },
        client: { artifactId: 'entity-drag-drop', exportName: 'activate' },
    });
    expect(contributions?.dropTargets?.find(target => target.id === 'inspect-item')).toMatchObject({
        acceptedKinds: ['session', 'plugin:examples.widget-areas/sample-card'],
        actions: [{ kind: 'plugin', action: 'inspect-drop' }],
    });
    const widget = contributions?.ui?.views?.find(view => view.id === 'snapshot-counter');
    expect(widget).toMatchObject({ container: 'widget', renderer: 'counter-declarative' });
    expect(contributions?.ui?.renderers?.find(renderer => renderer.id === 'counter-declarative')).toMatchObject({
        kind: 'declarative', documentSource: { kind: 'resource', resourceId: 'count-document' },
    });
    const plugin = await createPluginTestkit({ manifest: widgetAreasPlugin.manifest, module: widgetAreasPlugin });
    const directory = await mkdtemp(join(tmpdir(), 'happier-widget-snapshot-'));
    try {
        await writeFile(join(directory, 'note.txt'), 'one');
        const resource = plugin.registration('resources', 'count-document');
        if (!resource) throw new Error('Snapshot document Resource is not registered');
        const bytes = await resource.read(createTestResourceInvocationContext({ context: { kind: 'surface', mountInstanceKey: 'snapshot-counter',
            launchInput: { directory, filter: 'files' } }, signal: new AbortController().signal }));
        const document = definePluginDeclarativeDocumentV1(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)));
        expect(document).toMatchObject({ version: 1, root: { kind: 'metric', label: 'Files',
            data: { kind: 'value', value: 1 }, value: { path: [], type: 'number' } } });
        const preview = projectWidgetSnapshotPreviewV1({ document, frozenByPath: new Map(),
            asOf: '2026-10-17T00:00:00.000Z', provenance: [{ label: 'Directory count' }] });
        expect(preview?.document).toEqual(document);
        await writeFile(join(directory, 'second.txt'), 'two');
        const updated = await resource.read(createTestResourceInvocationContext({ context: { kind: 'surface', mountInstanceKey: 'snapshot-counter',
            launchInput: { directory, filter: 'files' } }, signal: new AbortController().signal }));
        expect(JSON.parse(typeof updated === 'string' ? updated : new TextDecoder().decode(updated)))
            .toMatchObject({ root: { data: { kind: 'value', value: 2 } } });
        expect(preview?.document.root).toMatchObject({ data: { kind: 'value', value: 1 } });
    } finally { await plugin.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it('activates the declared client source and target, admits host Sessions and its own typed item, and retires both', async () => {
    const target = { artifactId: 'entity-drag-drop', exportName: 'activate', platform: 'web' as const };
    const scope = createPluginRegistrationScope({ pluginId: widgetAreasPlugin.manifest.id, target: { realm: 'client', ...target },
        rights: derivePluginClientContributionRegistrationRights(widgetAreasPlugin.manifest.contributes ?? {}, target) });
    const opened: unknown[] = [];
    // Navigation is the external boundary; reference parsing and client registration stay real.
    const fixture = await createPluginUiTestkit({ authorPlugin: { id: widgetAreasPlugin.manifest.id, version: '1.0.0' },
        identity: { instanceId: 'entity-test', mountNonce: 'entity-mount' }, surface: {}, surfaceContext: createSurfaceContextFixture(),
        adapter: { mount: async () => ({ snapshot: async () => ({ revision: 1, nodes: [] }), update: async () => {}, invoke: async () => {}, dispose: async () => {} }) },
        handlers: { openSurface: ({ view, input }) => { opened.push({ view, input }); } } });
    try {
        activateEntities(scope.api);
        const registrations = scope.commit();
        const source = registrations.find(entry => entry.family === 'dragSources' && entry.localId === 'sample-card');
        const drop = registrations.find(entry => entry.family === 'dropTargets' && entry.localId === 'inspect-item');
        const action = registrations.find(entry => entry.family === 'actions' && entry.localId === 'inspect-drop');
        if (source?.family !== 'dragSources' || drop?.family !== 'dropTargets' || action?.family !== 'actions') throw new Error('Client declarations are not activated');
        const reference = { id: 'directory-check', title: 'Directory check' };
        expect(source.value.describe(reference)).toEqual({ title: 'Directory check', subtitle: 'Widget areas sample' });
        expect(source.value.describe({ id: 'directory-check', title: 'Directory check', secret: 'not allowed' })).toBeNull();
        const dragScope = { serverId: 'home', accountId: 'viewer' };
        for (const item of [
            { kind: 'session' as const, scope: dragScope, address: { serverId: 'home', sessionId: 'session-a' } },
            { kind: 'plugin' as const, scope: dragScope, contribution: { pluginId: widgetAreasPlugin.manifest.id, localId: 'sample-card' }, reference },
        ]) {
            const admission = drop.value.resolve({ item, destination: null, input: 'pointer', targetInput: null });
            expect(admission).toMatchObject({ status: 'allowed', effect: { actionId: 'plugin:examples.widget-areas/inspect-drop' } });
            if (admission.status !== 'allowed') throw new Error('Expected admitted item');
            expect(inspectedItemSchema.parse(admission.effect.input)).toMatchObject({ kind: item.kind === 'session' ? 'session' : 'sample' });
            await inspectDrop(admission.effect.input, { plugin: { id: widgetAreasPlugin.manifest.id, version: '1.0.0' },
                contribution: { id: 'inspect-drop', qualifiedId: 'examples.widget-areas/inspect-drop' }, invocationSurface: 'ui',
                signal: new AbortController().signal, ephemeralSharedScope: null,
                ui: { ...fixture.context.hostApi, context: async () => ({ targetedContributions: null }) } });
        }
        expect(opened).toEqual([
            { view: { pluginId: widgetAreasPlugin.manifest.id, localId: 'overview' }, input: { kind: 'session', address: { serverId: 'home', sessionId: 'session-a' } } },
            { view: { pluginId: widgetAreasPlugin.manifest.id, localId: 'overview' }, input: { kind: 'sample', reference } },
        ]);
        expect(drop.value.resolve({ item: { kind: 'plugin', scope: dragScope,
            contribution: { pluginId: 'other.plugin', localId: 'sample-card' }, reference }, destination: null, input: 'pointer', targetInput: null }))
            .toMatchObject({ status: 'refused' });
    } finally { await scope.dispose(); await fixture.dispose(); }
    expect(scope.registrations()).toEqual([]);
});

it('activates a real declared plugin and runs area inputs/layout/refresh through the public SDK client and host port', async () => {
    const plugin = await createPluginTestkit({ manifest: widgetAreasPlugin.manifest, module: widgetAreasPlugin });
    const directory = await mkdtemp(join(tmpdir(), 'happier-widget-area-'));
    await writeFile(join(directory, 'first.txt'), 'first');
    await writeFile(join(directory, 'second.txt'), 'second');
    await mkdir(join(directory, 'child'));
    const scope = { serverId: 'home', accountId: 'viewer' };
    const transport = createWorkBoardArtifactBoundary().forAccount(scope.accountId);
    const page = widgetAreasPlugin.manifest.contributes?.ui?.views?.find(view => view.id === 'overview');
    const widget = widgetAreasPlugin.manifest.contributes?.ui?.views?.find(view => view.id === 'counter');
    const inputType = widgetAreasPlugin.manifest.contributes?.inputTypes?.find(type => type.id === 'count-kind');
    if (!page || page.container !== 'appPage' || !page.widgetAreas || !widget || widget.container !== 'widget') throw new Error('Registered declarations missing');
    if (!inputType) throw new Error('Registered input type missing');
    const area = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true }));
    const deps = createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area },
        widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ ...widget, target: widget.target.kind }),
            readContext: async request => request.context.widgetAreaContext?.values ?? {}, readViewerValues: async () => ({ values: {} }),
            readInputType: async field => field.inputType && 'pluginId' in field.inputType
                && field.inputType.pluginId === widgetAreasPlugin.manifest.id && field.inputType.localId === inputType.id
                ? { identity: { pluginId: widgetAreasPlugin.manifest.id, localId: inputType.id },
                    occurrenceId: 'area-test', definition: inputType } : null,
            validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    // This Artifact-boundary fixture supplies only the external ports reached by widget-area Actions.
    const executor = createActionExecutor(deps);
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
            const bytes = await resource.read(createTestResourceInvocationContext({ context: { kind: 'surface', mountInstanceKey: 'area-test',
                launchInput: { directory, filter } }, signal: new AbortController().signal }));
            return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
        };
        expect(await read('files')).toEqual({ directory, filter: 'files', count: 2 });
        expect(await read('folders')).toEqual({ directory, filter: 'folders', count: 1 });
        let invalidate: () => void = () => {};
        const invalidated = new Promise<void>(resolve => { invalidate = resolve; });
        const observer = await resource.observe(invalidate, createTestResourceInvocationContext({ context: { kind: 'surface', mountInstanceKey: 'area-test',
            launchInput: { directory, filter: 'files' } }, signal: new AbortController().signal }));
        try {
            await writeFile(join(directory, 'third.txt'), 'third');
            await invalidated;
        } finally { observer.dispose(); }
        expect(await read('files')).toEqual({ directory, filter: 'files', count: 3 });
        await expect(resource.read(createTestResourceInvocationContext({ context: { kind: 'surface', mountInstanceKey: 'area-test',
            launchInput: { directory: join(directory, 'missing'), filter: 'files' } }, signal: new AbortController().signal })))
            .rejects.toMatchObject({ code: 'ENOENT' });
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: widgetAreasPlugin.manifest.id, localId: widget.id } },
            bindings: { directory: { kind: 'context' as const, slot: 'directory' }, filter: { kind: 'context' as const, slot: 'filter' } } };
        const added = await runWidgetAreaExample(fixture.context.hostApi, { actionId: 'widgets.item.add', instance }, 'files', directory);
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
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

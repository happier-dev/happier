import { createElement } from 'react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createPluginWidgetAreaHostPortV1 } from '@happier-dev/protocol/plugins/ui';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetActionInputResolverV1 } from '@happier-dev/protocol/widgets';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { createWorkBoardArtifactBoundary } from '../../../protocol/src/boards/workBoardArtifactV1.testkit.js';
import { widgetAreasPlugin } from '../../../plugin-sdk/examples/widget-areas/index.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiWidgetAreaPresentation } from '../presentationHost/context.js';

it('mounts the registered page area, changes followed context and reloads configured Resource widgets through the public author path', async () => {
  const plugin = await createPluginTestkit({ manifest: widgetAreasPlugin.manifest, module: widgetAreasPlugin });
  try {
    const ui = widgetAreasPlugin.manifest.contributes?.ui;
    const page = ui?.views?.find(view => view.id === 'overview');
    const widget = ui?.views?.find(view => view.id === 'counter');
    if (!page || page.container !== 'appPage' || !page.widgetAreas || !widget || widget.container !== 'widget') throw new Error('Missing registered views');
    const pageRenderer = ui?.renderers?.find(renderer => renderer.id === page.renderer);
    const widgetRenderer = ui?.renderers?.find(renderer => renderer.id === widget.renderer);
    expect(pageRenderer?.kind).toBe('reactNative');
    expect(widgetRenderer?.kind).toBe('reactNative');
    if (pageRenderer?.kind !== 'reactNative' || widgetRenderer?.kind !== 'reactNative') throw new Error('Expected native author renderers');
    const packageJson: { exports: Readonly<Record<string, string>> } = JSON.parse(await readFile(
      resolve(process.cwd(), '../plugin-sdk/examples/widget-areas/package.json'), 'utf8'));
    const loadRenderer = async (artifact: string): Promise<RenderSurface> => {
      expect(packageJson.exports[`./happier-plugin-ui/${artifact}`]).toBe(`./ui/${artifact}.tsx`);
      const module = await import(`../../../plugin-sdk/examples/widget-areas/ui/${artifact}.tsx`);
      return module.renderSurface;
    };
    const nativePage = await loadRenderer(pageRenderer.artifact);
    const nativeWidget = await loadRenderer(widgetRenderer.artifact);
    const resource = plugin.registration('resources', 'count');
    if (!resource) throw new Error('Missing registered Resource');
    const scope = { serverId: 'home', accountId: 'viewer' };
    const boundary = createWorkBoardArtifactBoundary();
    const transport = boundary.forAccount(scope.accountId);
    const area = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true }));
    const deps = {
      widgetAccountScope: () => scope,
      widgetSurfaceActions: { pluginArea: area },
      widgetInputs: createWidgetActionInputResolverV1({
        readDescriptor: async () => widget,
        readContext: async request => request.context.widgetAreaContext?.values ?? {},
        readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
      }),
    } satisfies Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetSurfaceActions' | 'widgetInputs'>;
    // Only external Artifact/descriptor ports are supplied; admission and semantic mutation stay real.
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: widgetAreasPlugin.manifest.id, pageId: page.id,
      declarations: page.widgetAreas, isCurrent: () => true,
      execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'ui', bypassApprovals: true }),
    });
    let presented: PluginUiWidgetAreaPresentation | undefined;
    // The visual area is the host boundary. Capture the author's actual WidgetSurface request,
    // then execute it against the incumbent host port and Artifact owner, never a fixture layout.
    const surface: RenderSurface = context => createElement(PluginUiPresentationHostProviderInternal, {
      host: { renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null, renderIcon: () => null,
        renderWidgetArea: request => { presented = request; return null; } },
    }, nativePage(context));
    const mountPage = () => createPluginUiTestkit({
      identity: { instanceId: 'example-page', mountNonce: 'example-page-mount' },
      authorPlugin: { id: widgetAreasPlugin.manifest.id, version: '1.0.0' }, surface,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', container: 'appPage',
        destination: { pluginId: widgetAreasPlugin.manifest.id, localId: page.id } }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { widgetArea: ({ request, signal }) => port.execute(request, signal) },
    });
    const pageMount = await mountPage();
    const instance = (id: string, pinned = false) => ({ v: 1 as const, id,
      definition: { kind: 'installed' as const, surface: { pluginId: widgetAreasPlugin.manifest.id, localId: widget.id } },
      bindings: { filter: pinned ? { kind: 'value' as const, value: 'open' } : { kind: 'context' as const, slot: 'filter' } },
    });
    const execute = async (operation: Parameters<PluginUiWidgetAreaPresentation['port']['execute']>[0]) => {
      if (!presented) throw new Error('The registered page did not embed its declared area');
      return presented.port.execute(operation, presented.context);
    };
    try {
      expect(presented?.context).toEqual({ filter: 'open' });
      expect(await execute({ actionId: 'widgets.instance.add', instance: instance('following') })).toMatchObject({ ok: true });
      expect(await execute({ actionId: 'widgets.instance.add', instance: instance('pinned', true) })).toMatchObject({ ok: true });
      expect(await execute({ actionId: 'widgets.instance.width.set', instanceId: 'following', width: 'full' })).toMatchObject({ ok: true });
      expect(await execute({ actionId: 'widgets.instance.move', instanceId: 'pinned', toIndex: 0 })).toMatchObject({ ok: true });
      await pageMount.press(await pageMount.getByRole('radio', { name: 'Closed' }));
      expect(presented?.context).toEqual({ filter: 'closed' });
      for (const [id, pinned, filter] of [['following', false, 'closed'], ['pinned', true, 'open']] as const) {
        const input = await execute({ actionId: 'widgets.instance.inputs.validate', instanceId: id, bindings: instance(id, pinned).bindings });
        expect(input).toEqual({ ok: true, result: { status: 'ready', input: { filter } } });
        if (!input.ok || !('input' in input.result)) throw new Error('Inputs were not admitted');
        const readResource = vi.fn(async ({ resource: ref }: Readonly<{ resource: unknown }>) => {
          expect(ref).toEqual({ pluginId: widgetAreasPlugin.manifest.id, localId: 'count' });
          const bytes = await resource.read({ context: { kind: 'global' }, signal: new AbortController().signal });
          return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
            bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes };
        });
        const body = await createPluginUiTestkit({
          identity: { instanceId: id, mountNonce: `${id}-mount` }, authorPlugin: { id: widgetAreasPlugin.manifest.id, version: '1.0.0' },
          surface: nativeWidget, launchInput: input.result.input,
          surfaceContext: createSurfaceContextFixture({ mount: { kind: 'embedded', role: 'widget', presentation: 'content' }, target: { kind: 'app' } }),
          adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { readResource },
        });
        try {
          await vi.waitFor(async () => { expect(await body.getByText('42')).toEqual({ content: '42' }); });
          await body.getByText(`Filter: ${filter}`);
          expect(readResource).toHaveBeenCalled();
        } finally { await body.dispose(); }
      }
    } finally { await pageMount.dispose(); }
    const reload = await mountPage();
    try {
      expect(await execute({ actionId: 'widgets.instance.list' })).toMatchObject({ ok: true, result: { instances: [
        { instance: instance('pinned', true), width: 'half' }, { instance: instance('following'), width: 'full' },
      ] } });
      expect(boundary.rows.size).toBe(1);
    } finally { await reload.dispose(); }
  } finally { await plugin.dispose(); }
});

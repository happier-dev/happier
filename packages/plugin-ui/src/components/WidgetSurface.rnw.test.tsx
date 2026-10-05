import { describe, expect, it, vi } from 'vitest';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost, type PluginUiWidgetAreaPresentation } from '../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { WidgetSurface } from '../index.js';

function presentationHost(renderWidgetArea?: PluginUiPresentationHost['renderWidgetArea']): PluginUiPresentationHost {
  return {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...(renderWidgetArea === undefined ? {} : { renderWidgetArea }),
  };
}

describe('WidgetSurface', () => {
  it('lends the host the mounted area port and page context, and every operation reaches the Host API for that area', async () => {
    const context = createSurfaceContext();
    const widgetArea = vi.fn<PluginUiHostApi['widgetArea']>(async () => ({ ok: true, result: { surface: { serverId: 'home', accountId: 'a', owner: { kind: 'home' } }, instances: [], canEdit: true } }));
    const requests: PluginUiWidgetAreaPresentation[] = [];
    const renderWidgetArea = (request: PluginUiWidgetAreaPresentation) => {
      requests.push(request);
      return <span data-testid="host-area">{request.area}</span>;
    };
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context, { widgetArea })} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost(renderWidgetArea)}>
          <WidgetSurface area="pinned" context={{ repository: 'happier' }} title="Pinned" fallback={<span data-testid="fallback" />} />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    expect(mount.container.querySelector('[data-testid="host-area"]')?.textContent).toBe('pinned');
    expect(mount.container.querySelector('[data-testid="fallback"]')).toBeNull();
    const request = requests.at(-1)!;
    expect(request).toMatchObject({ area: 'pinned', context: { repository: 'happier' }, title: 'Pinned' });

    // The author names an operation; the host binds area and context — never a surface, Home or Account.
    await request.port.execute({ actionId: 'widgets.instance.list' }, request.context);
    expect(widgetArea).toHaveBeenCalledWith({ area: 'pinned', operation: { actionId: 'widgets.instance.list' }, context: { repository: 'happier' } }, undefined);
    mount.unmount();
  });

  it('renders the author fallback where an isolated host cannot present widgets', () => {
    const context = createSurfaceContext();
    const widgetArea = vi.fn<PluginUiHostApi['widgetArea']>();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context, { widgetArea })} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost()}>
          <WidgetSurface area="pinned" fallback={<span data-testid="fallback">Open on Home</span>} />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    expect(mount.container.querySelector('[data-testid="fallback"]')?.textContent).toBe('Open on Home');
    expect(widgetArea).not.toHaveBeenCalled();
    mount.unmount();
  });
});

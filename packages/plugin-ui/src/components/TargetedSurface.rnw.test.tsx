import type { ContributionSurfaceHandle } from '@happier-dev/plugin-sdk/contributions';
import { describe, expect, it, vi } from 'vitest';

import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { mountThroughReactNativeWeb, mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { TargetedSurface } from '../index.js';

const detailSurface = {
  point: {
    pointId: 'triage-details',
    protocol: { id: 'triage-source', version: 1 },
  },
  contributor: {
    pluginId: 'com.acme.source',
    contributionId: 'pull-request-detail',
    immutableGenerationId: 'source-generation-a',
  },
  role: 'detail',
  presentation: 'content',
} as const satisfies ContributionSurfaceHandle<Readonly<{ entryId: string }>, 'triage-details'>;

function presentationHost(
  renderTargetedSurface?: PluginUiPresentationHost['renderTargetedSurface'],
): PluginUiPresentationHost {
  return {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...(renderTargetedSurface === undefined ? {} : { renderTargetedSurface }),
  };
}

describe('TargetedSurface', () => {
  it('delegates the exact target-local handle, launch input, raw instance key, and fallback through the incumbent presentation-host bridge', () => {
    const context = createSurfaceContext();
    const input = { entryId: 'PR-42' } as const;
    const fallback = <span data-testid="targeted-fallback">Cached detail</span>;
    const renderTargetedSurface = vi.fn((request: Parameters<NonNullable<PluginUiPresentationHost['renderTargetedSurface']>>[0]) => (
      <span data-testid="targeted-child">{request.input.entryId}</span>
    ));

    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost(renderTargetedSurface)}>
          <TargetedSurface surface={detailSurface} input={input} instanceKey="entry-42" fallback={fallback} />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(renderTargetedSurface).toHaveBeenCalledTimes(1);
    expect(renderTargetedSurface).toHaveBeenCalledWith({
      surface: detailSurface,
      input,
      instanceKey: 'entry-42',
      fallback,
    });
    expect(mount.container.querySelector('[data-testid="targeted-child"]')?.textContent).toBe('PR-42');
    expect(mount.container.querySelector('[data-testid="targeted-fallback"]')).toBeNull();
    mount.unmount();
  });

  it('renders the supplied fallback when the mounted parent has no targeted-surface bridge', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <TargetedSurface
          surface={detailSurface}
          input={{ entryId: 'PR-42' }}
          fallback={<span data-testid="targeted-fallback">Unsupported here</span>}
        />
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('[data-testid="targeted-fallback"]')?.textContent).toBe('Unsupported here');
    mount.unmount();
  });

  it('falls back and reports a bounded diagnostic when a targeted child attempts another targeted surface', async () => {
    const context = createSurfaceContext();
    const diagnostic = vi.fn();
    const nestedTargetedSurfaceHost = {
      ...presentationHost(),
      targetedSurfaceUnavailableReason: 'unsupported_nested_targeted_surface',
    } as PluginUiPresentationHost;
    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={createHostApiStub(context, { diagnostic })} context={context}>
        <PluginUiPresentationHostProviderInternal host={nestedTargetedSurfaceHost}>
          <TargetedSurface
            surface={detailSurface}
            input={{ entryId: 'PR-42' }}
            fallback={<span data-testid="targeted-fallback">Nested surfaces are unsupported here</span>}
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('[data-testid="targeted-fallback"]')?.textContent).toBe('Nested surfaces are unsupported here');
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      code: 'unsupported_nested_targeted_surface',
      severity: 'warning',
    });
    mount.unmount();
  });
});

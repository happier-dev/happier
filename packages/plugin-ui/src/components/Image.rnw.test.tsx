import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb, mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createAdmittedBrandPngFixture, createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { BrandMark, Image as ResourceImage } from './Image.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { PluginUiPresentationHostProviderInternal } from '../presentationHost/context.js';

const TRANSPARENT_BRAND_BYTES = createAdmittedBrandPngFixture();

async function mountAdmittedBrandMark(context: ReturnType<typeof createSurfaceContext>) {
  const mount = await mountThroughReactNativeWebAsync(
    <PluginUiProvider
      hostApi={createHostApiStub(context, {
        readResource: async () => ({
          contentType: 'image/png',
          digest: `sha256:${'b'.repeat(64)}`,
          bytes: TRANSPARENT_BRAND_BYTES,
        }),
      })}
      context={context}
    >
      <PluginUiPresentationHostProviderInternal host={{
        brand: {
          displayName: 'GitHub',
          resource: { pluginId: 'happier.scm.forge.github', localId: 'brand-icon' },
        },
        renderMarkdown: () => null,
        renderCodeBlock: () => null,
        renderPopover: () => null,
        renderIcon: () => null,
      }}>
        <BrandMark />
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>,
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return mount;
}

function renderedColor(property: 'backgroundColor' | 'borderColor', color: string): string {
  const probe = document.createElement('div');
  probe.style[property] = color;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return value;
}

describe('bounded package image and brand fallback', () => {
  it('reports one attributable diagnostic and renders the neutral fallback when the web decoder fails', async () => {
    const context = createSurfaceContext();
    const diagnostic = vi.fn();
    const resource = { pluginId: 'example.images', localId: 'broken-at-decode' };
    const BrowserImage = window.Image;
    class FailingBrowserImage {
      onerror: ((event: Event) => void) | null = null;
      onload: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.(new Event('error')));
      }
    }
    Object.defineProperty(window, 'Image', { configurable: true, value: FailingBrowserImage });
    try {
      const mount = await mountThroughReactNativeWebAsync(
        <PluginUiProvider
          hostApi={createHostApiStub(context, {
            diagnostic,
            readResource: async () => ({
              contentType: 'image/png',
              digest: `sha256:${'e'.repeat(64)}`,
              bytes: createAdmittedBrandPngFixture({ admit: false }),
            }),
          })}
          context={context}
        >
          <ResourceImage resource={resource} fallback="NO" accessibilityLabel="Broken image" />
        </PluginUiProvider>,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mount.container.querySelector('img')).toBeNull();
      expect(mount.container.textContent).toBe('NO');
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith({
        code: 'plugin_renderable_image_decode_failed',
        severity: 'warning',
        message: 'The platform image decoder could not render this packaged PNG.',
        details: { resource },
      });
      mount.unmount();
    } finally {
      Object.defineProperty(window, 'Image', { configurable: true, value: BrowserImage });
    }
  });

  it('backs an admitted transparent brand mark with the host semantic surface in light, dark, and high-contrast contexts', async () => {
    const cases = [
      { colorScheme: 'light' as const, contrast: 'normal' as const, background: 'surface' as const },
      { colorScheme: 'dark' as const, contrast: 'normal' as const, background: 'text' as const },
      { colorScheme: 'dark' as const, contrast: 'high' as const, background: 'text' as const },
    ];

    for (const current of cases) {
      const context = createSurfaceContext({
        colorScheme: current.colorScheme,
        contrast: current.contrast,
      });
      const mount = await mountAdmittedBrandMark(context);
      const image = mount.container.querySelector<HTMLElement>('[aria-label="GitHub"]');
      const sourceImage = image?.querySelector<HTMLImageElement>('img');

      expect(image).not.toBeNull();
      expect(sourceImage?.getAttribute('src')).toBe(
        `data:image/png;base64,${Buffer.from(TRANSPARENT_BRAND_BYTES).toString('base64')}`,
      );
      expect(getComputedStyle(image!).backgroundColor).toBe(
        renderedColor('backgroundColor', context.theme.colors[current.background]),
      );
      mount.unmount();
    }
  });

  it('uses the canonical display name exactly once beside a neutral fallback', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={{
          brand: { displayName: 'Conversation Channels' },
          renderMarkdown: () => null,
          renderCodeBlock: () => null,
          renderPopover: () => null,
          renderIcon: () => null,
        }}>
          <BrandMark showName testID="conversation-mark" />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(mount.container.textContent).toBe('CConversation Channels');
    expect(mount.container.querySelectorAll('[aria-label="Conversation Channels"]')).toHaveLength(0);
    expect(mount.container.querySelector('[data-testid="conversation-mark"]')?.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    mount.unmount();
  });

  it('keeps a missing Telegram mark as one high-contrast, display-name-labelled neutral fallback', () => {
    const context = createSurfaceContext({ colorScheme: 'dark', contrast: 'high' });
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={{
          brand: { displayName: 'Telegram Channels' },
          renderMarkdown: () => null,
          renderCodeBlock: () => null,
          renderPopover: () => null,
          renderIcon: () => null,
        }}>
          <BrandMark />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    const fallback = mount.container.querySelector<HTMLElement>('[aria-label="Telegram Channels"]');
    expect(mount.container.textContent).toBe('T');
    expect(fallback).not.toBeNull();
    expect(getComputedStyle(fallback!).backgroundColor).toBe(
      renderedColor('backgroundColor', context.theme.colors.text),
    );
    expect(fallback?.firstElementChild).not.toBeNull();
    expect(getComputedStyle(fallback!.firstElementChild!).color).toBe(
      renderedColor('backgroundColor', context.theme.colors.surface),
    );
    mount.unmount();
  });

  it('delegates one exact target mark to the private host without reading the mounted plugin Resource', () => {
    const context = createSurfaceContext();
    const readResource = vi.fn(async () => ({
      contentType: 'image/png' as const,
      digest: `sha256:${'d'.repeat(64)}`,
      bytes: TRANSPARENT_BRAND_BYTES,
    }));
    const renderBrandMark = vi.fn((input: Readonly<{
      pluginId: string;
      size?: 'small' | 'medium' | 'large';
      showName?: boolean;
      testID?: string;
    }>) => (
      <span
        data-testid={input.testID}
        aria-label="Target Provider"
      >
        Target Provider
      </span>
    ));
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context, { readResource })} context={context}>
        <PluginUiPresentationHostProviderInternal host={{
          brand: {
            displayName: 'Mounted Plugin',
            resource: { pluginId: 'example.mounted', localId: 'brand-icon' },
          },
          resolveBrandDisplayName: () => 'Target Provider',
          renderBrandMark,
          renderMarkdown: () => null,
          renderCodeBlock: () => null,
          renderPopover: () => null,
          renderIcon: () => null,
        } as never}>
          <BrandMark {...({ pluginId: 'example.provider', size: 'small', testID: 'target-provider-mark' } as never)} />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(renderBrandMark).toHaveBeenCalledWith({
      pluginId: 'example.provider',
      size: 'small',
      showName: false,
      externallyLabelled: false,
      testID: 'target-provider-mark',
    });
    expect(mount.container.querySelector('[aria-label="Target Provider"]')).not.toBeNull();
    expect(readResource).not.toHaveBeenCalled();
    mount.unmount();
  });
});

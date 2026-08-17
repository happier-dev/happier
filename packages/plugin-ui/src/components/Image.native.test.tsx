import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// React Native is the platform boundary. The presentation and resource path
// remain real so this validates the style passed to the native Image host.
vi.mock('react-native', () => ({
  Image: 'Image',
  Text: 'Text',
  View: 'View',
}));

import { PluginUiPresentationHostProviderInternal } from '../presentationHost/context.js';
import { HappierBrandMark, resolveHappierBrandFallback } from '../presentation/content/Image.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { BrandMark } from './Image.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const TRANSPARENT_BRAND_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('native BrandMark presentation', () => {
  it('preserves the first display-name grapheme in its neutral fallback', () => {
    expect(resolveHappierBrandFallback('🤖 Tools')).toBe('🤖');
    expect(resolveHappierBrandFallback('e\u0301clair')).toBe('E\u0301');
    expect(resolveHappierBrandFallback('   ')).toBe('?');
  });

  it('preserves the fallback when the runtime does not provide Intl.Segmenter', async () => {
    const segmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Object.defineProperty(Intl, 'Segmenter', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    vi.resetModules();

    try {
      const { resolveHappierBrandFallback: resolveWithoutSegmenter } = await import('../presentation/content/Image.js');
      expect(resolveWithoutSegmenter('🤖 Tools')).toBe('🤖');
      expect(resolveWithoutSegmenter('e\u0301clair')).toBe('E\u0301');
      expect(resolveWithoutSegmenter('👩🏽‍💻 Tools')).toBe('👩🏽‍💻');
      expect(resolveWithoutSegmenter('🇨🇭 Tools')).toBe('🇨🇭');
    } finally {
      if (segmenterDescriptor) {
        Object.defineProperty(Intl, 'Segmenter', segmenterDescriptor);
      } else {
        delete (Intl as { Segmenter?: unknown }).Segmenter;
      }
      vi.resetModules();
    }
  });

  it('renders the package-internal brand presentation without a PluginUiProvider resource scope', async () => {
    const context = createSurfaceContext({ colorScheme: 'dark', contrast: 'high' });

    await act(async () => {
      renderer = create(
        <HappierBrandMark
          displayName="GitHub"
          bytes={TRANSPARENT_BRAND_BYTES}
          theme={context.theme}
          colorScheme={context.colorScheme}
          externallyLabelled
        />,
      );
    });

    const image = renderer.root.findByType('Image');
    expect(image.props.accessibilityLabel).toBeUndefined();
    expect(image.props.style).toMatchObject({
      backgroundColor: context.theme.colors.text,
      borderRadius: context.theme.radii.control,
    });
  });

  it('passes an opaque, high-contrast semantic backing to the native image host', async () => {
    const context = createSurfaceContext({ colorScheme: 'dark', contrast: 'high' });

    await act(async () => {
      renderer = create(
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
      await Promise.resolve();
      await Promise.resolve();
    });

    const image = renderer!.root.findByType('Image');
    expect(image.props.source.uri).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(image.props.style).toMatchObject({
      backgroundColor: context.theme.colors.text,
      borderRadius: context.theme.radii.control,
    });
  });
});

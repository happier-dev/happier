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
import { createAdmittedBrandPngFixture, createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { BrandMark } from './Image.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const TRANSPARENT_BRAND_BYTES = createAdmittedBrandPngFixture();

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
    expect(image.props.source.uri).toBe(
      `data:image/png;base64,${Buffer.from(TRANSPARENT_BRAND_BYTES).toString('base64')}`,
    );
    expect(image.props.style).toMatchObject({
      backgroundColor: context.theme.colors.text,
      borderRadius: context.theme.radii.control,
    });
  });

  it('does not re-encode a digest-equal reread that arrives as fresh bytes', async () => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    const digest = `sha256:${'c'.repeat(64)}`;
    // A length divisible by three makes indexed reads exactly one per byte
    // per conversion, with no read past the final triple. Admission is left to
    // the store below, which is the owner under test here.
    const brandBytes = createAdmittedBrandPngFixture({ byteLength: 27, admit: false });
    let reads = 0;
    // Every read hands back a DISTINCT array with the same admitted digest,
    // which is what a real transport does. Counting indexed reads measures
    // conversions without instrumenting the presentation module.
    let indexedReads = 0;
    const readResource = async () => {
      reads += 1;
      const fresh = new Uint8Array(brandBytes);
      const counted = new Proxy(fresh, {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/u.test(key)) indexedReads += 1;
          return Reflect.get(target, key, target) as unknown;
        },
      }) as Uint8Array;
      return { contentType: 'image/png' as const, digest, bytes: counted };
    };

    const host = createHostApiStub(context, { readResource });
    const tree = (mounted: boolean) => (
      <PluginUiProvider hostApi={host} context={context}>
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
          {mounted ? <BrandMark /> : null}
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>
    );

    await act(async () => {
      renderer = create(tree(true));
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstSource = renderer!.root.findByType('Image').props.source;
    // The header probe reads a fixed 20 bytes before the conversion does its
    // one pass, so a conversion is `byteLength + 20` indexed reads.
    const readsPerConversion = brandBytes.byteLength + 20;
    const conversionsAfterFirstMount = indexedReads / readsPerConversion;

    // Remount through the same provider: the store rereads canonically and the
    // reread lands on the same digest with a brand-new array.
    await act(async () => {
      renderer!.update(tree(false));
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.update(tree(true));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reads).toBeGreaterThan(1);
    expect(conversionsAfterFirstMount).toBe(1);
    expect(indexedReads / readsPerConversion).toBe(1);
    expect(renderer!.root.findByType('Image').props.source).toBe(firstSource);
  });
});

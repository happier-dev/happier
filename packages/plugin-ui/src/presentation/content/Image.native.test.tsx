import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// React Native is the platform boundary. The presentation path stays real so
// this measures the byte work the native image host actually causes.
vi.mock('react-native', () => ({
  Image: 'Image',
  Text: 'Text',
  View: 'View',
}));

import { createAdmittedBrandPngFixture, createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { HappierBrandMark, HappierImage } from './Image.js';
import { materializeHappierRenderableImage } from './renderableImage.js';

/**
 * Counts every indexed byte read the render performs, without instrumenting the
 * module under test. One base64 conversion of `bytes` reads each index exactly
 * once, so any non-zero count during render is a conversion the reader waits on.
 */
function countingBytes(bytes: Uint8Array): Readonly<{ proxy: Uint8Array; reads: () => number }> {
  let reads = 0;
  const proxy = new Proxy(bytes, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) reads += 1;
      return Reflect.get(target, key, target) as unknown;
    },
  }) as Uint8Array;
  return { proxy, reads: () => reads };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function pngBytes(width: number, height: number, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set(PNG_SIGNATURE, 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  for (let index = 24; index < byteLength; index += 1) bytes[index] = index % 251;
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], byteLength - 12);
  return bytes;
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('HappierImage byte source derivation', () => {
  it.each([false, true])('ignores unsupported runtime source and host props with admitted bytes: %s', async (withBytes) => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    const bytes = withBytes ? createAdmittedBrandPngFixture() : undefined;
    const imageHost = vi.fn(() => null);
    // JavaScript callers can supply extra props despite the public TS contract.
    const runtimeProps = {
      displayName: 'GitHub',
      bytes,
      theme: context.theme,
      source: { uri: 'https://example.invalid/unsupported.png' },
      imageHost,
    };

    await act(async () => {
      renderer = create(<HappierBrandMark {...runtimeProps} />);
    });

    expect(imageHost).not.toHaveBeenCalled();
    if (bytes) {
      const admitted = materializeHappierRenderableImage(bytes);
      expect(admitted.admitted).toBe(true);
      expect(renderer!.root.findByType('Image').props.source).toBe(admitted.admitted ? admitted.source : null);
    } else {
      expect(renderer!.root.findAllByType('Image')).toHaveLength(0);
      expect(renderer!.root.findByType('Text').props.children).toBe('G');
    }
  });

  it('exposes the decoder-failure callback on the public brand-mark contract', async () => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    const onDecodeError = vi.fn();

    await act(async () => {
      renderer = create(
        <HappierBrandMark
          displayName="GitHub"
          bytes={createAdmittedBrandPngFixture()}
          theme={context.theme}
          onDecodeError={onDecodeError}
        />,
      );
    });
    await act(async () => renderer!.root.findByType('Image').props.onError());

    expect(renderer!.root.findAllByType('Image')).toHaveLength(0);
    expect(renderer!.root.findByType('Text').props.children).toBe('G');
    expect(onDecodeError).toHaveBeenCalledTimes(1);
  });

  it('transitions an admitted source through the existing neutral fallback after a decoder error', async () => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    const bytes = createAdmittedBrandPngFixture({ admit: false });
    expect(materializeHappierRenderableImage(bytes).admitted).toBe(true);
    const onDecodeError = vi.fn();

    await act(async () => {
      renderer = create(
        <HappierImage
          bytes={bytes}
          fallback="PX"
          theme={context.theme}
          brandMark
          onDecodeError={onDecodeError}
        />,
      );
    });
    const image = renderer!.root.findByType('Image');
    await act(async () => image.props.onError());

    expect(renderer!.root.findAllByType('Image')).toHaveLength(0);
    expect(renderer!.root.findByType('Text').props.children).toBe('PX');
    expect(onDecodeError).toHaveBeenCalledTimes(1);
  });

  it('reads no bytes at all during render, because materialization is not a render', async () => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    const counted = countingBytes(pngBytes(32, 32, 3_072));
    // The admitting owner materializes off the render path, exactly as the
    // Resource store and the host brand reader do when bytes arrive. It reads
    // every byte exactly once; every read after this point belongs to a render.
    const admitted = materializeHappierRenderableImage(counted.proxy);
    expect(admitted.admitted).toBe(true);
    expect(counted.reads()).toBeGreaterThanOrEqual(3_072);
    const materializationReads = counted.reads();

    const render = (label: string) => (
      <HappierImage bytes={counted.proxy} fallback="?" theme={context.theme} accessibilityLabel={label} />
    );

    await act(async () => {
      renderer = create(render('render-0'));
    });
    const firstSource = renderer!.root.findByType('Image').props.source;
    const readsAfterFirstRender = counted.reads() - materializationReads;

    for (let index = 1; index < 10; index += 1) {
      await act(async () => {
        renderer!.update(render(`render-${index}`));
      });
    }

    const lastSource = renderer!.root.findByType('Image').props.source;

    // Zero conversions, not one and not ten: the source was already derived.
    expect(readsAfterFirstRender).toBe(0);
    expect(counted.reads() - materializationReads).toBe(0);
    expect(firstSource).toBe(admitted.admitted ? admitted.source : null);
    expect(lastSource).toBe(firstSource);
  });

  it('presents the neutral fallback for bytes no owner admitted, without converting them', async () => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    // Bytes no owner ever admitted — the shape a refused mark and a mark that
    // never reached an admitting owner both arrive in. The renderer must never
    // be the thing that pays to find out which.
    const counted = countingBytes(pngBytes(32, 32, 3_072));

    await act(async () => {
      renderer = create(
        <HappierImage
          bytes={counted.proxy}
          fallback="AB"
          theme={context.theme}
          brandMark
        />,
      );
    });

    expect(renderer!.root.findAllByType('Image')).toHaveLength(0);
    expect(counted.reads()).toBe(0);
  });
});

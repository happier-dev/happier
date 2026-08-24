import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
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
  it('exposes the decoder-failure callback on the public brand-mark contract', async () => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    const onDecodeError = vi.fn();

    await act(async () => {
      renderer = create(
        <HappierBrandMark
          displayName="GitHub"
          bytes={createAdmittedBrandPngFixture()}
          theme={context.theme}
          colorScheme={context.colorScheme}
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
          backing={{ backgroundColor: '#101010', foregroundColor: '#f0f0f0' }}
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
          // The brand composition's explicit colors; it keeps this assertion on
          // the source decision rather than on `HappierText`'s theme context.
          backing={{ backgroundColor: '#101010', foregroundColor: '#f0f0f0' }}
        />,
      );
    });

    expect(renderer!.root.findAllByType('Image')).toHaveLength(0);
    expect(counted.reads()).toBe(0);
  });
});

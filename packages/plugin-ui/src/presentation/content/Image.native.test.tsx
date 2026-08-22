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

import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { HappierImage } from './Image.js';

/**
 * Counts every indexed byte read the encoder performs, without instrumenting
 * the module under test: one conversion of `bytes` reads each index exactly
 * once, so `reads / byteLength` is the number of conversions.
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

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('HappierImage byte source derivation', () => {
  it('converts one admitted byte identity exactly once across renders', async () => {
    const context = createSurfaceContext({ colorScheme: 'light', contrast: 'normal' });
    const bytes = new Uint8Array(3_072);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const counted = countingBytes(bytes);

    const render = (label: string) => (
      <HappierImage bytes={counted.proxy} fallback="?" theme={context.theme} accessibilityLabel={label} />
    );

    await act(async () => {
      renderer = create(render('render-0'));
    });
    const firstSource = renderer!.root.findByType('Image').props.source;
    const readsAfterFirstRender = counted.reads();

    for (let index = 1; index < 10; index += 1) {
      await act(async () => {
        renderer!.update(render(`render-${index}`));
      });
    }

    const lastSource = renderer!.root.findByType('Image').props.source;

    // One conversion, not ten: `reads / byteLength` is the conversion count.
    expect(readsAfterFirstRender).toBe(bytes.byteLength);
    expect(counted.reads()).toBe(bytes.byteLength);
    expect(lastSource).toBe(firstSource);
  });
});

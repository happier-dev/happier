import { describe, expect, it, vi } from 'vitest';

import {
  HAPPIER_MAX_RENDERABLE_IMAGE_BYTES,
  HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS,
} from '../presentation/content/renderableImage.js';
import {
  createPluginUiResourceStore,
  type PluginUiResourceClient,
} from './resourceStore.js';

/** A PNG prefix that declares `width x height` and pads to `byteLength`. */
function pngBytes(width: number, height: number, byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(byteLength, 24));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], bytes.length - 12);
  return bytes;
}

function imageResource(bytes: Uint8Array, digest: string) {
  return { bytes, contentType: 'image/png', digest };
}

/**
 * A refused renderable image is deliberately invisible on every user-facing
 * surface — it presents exactly like an image the author never shipped. These
 * tests hold the only channel that can tell the author otherwise.
 */
describe('plugin UI Resource store renderable-image refusals', () => {
  it('reports the refusing bound and the Resource identity to the mounted author diagnostic channel', async () => {
    // A canvas past the decode ceiling inside a payload the byte ceiling admits:
    // exactly the case where only the pixel bound refuses.
    const side = Math.ceil(Math.sqrt(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS)) + 1;
    const bytes = pngBytes(side, side, 4_096);
    expect(bytes.byteLength).toBeLessThan(HAPPIER_MAX_RENDERABLE_IMAGE_BYTES);

    const diagnostic = vi.fn();
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => imageResource(bytes, 'sha256:refused')),
      diagnostic,
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('brand');
    const unsubscribe = entry.subscribe(() => undefined, false);

    await vi.waitFor(() => {
      expect(entry.getSnapshot().freshness).toBe('fresh');
    });

    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0]![0]).toEqual({
      code: 'plugin_renderable_image_too_many_pixels',
      severity: 'warning',
      message: expect.any(String),
      details: {
        byteLength: bytes.byteLength,
        pixels: side * side,
        limit: HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS,
        // Without the identity the author cannot tell which of their Resources
        // was refused, which is most of what makes the diagnostic actionable.
        resource: 'acme.preview/brand',
      },
    });

    unsubscribe();
    store.dispose();
  });

  it('says nothing when the image is admitted', async () => {
    const diagnostic = vi.fn();
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => imageResource(pngBytes(16, 16, 128), 'sha256:ok')),
      diagnostic,
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('brand');
    const unsubscribe = entry.subscribe(() => undefined, false);

    await vi.waitFor(() => {
      expect(entry.getSnapshot().freshness).toBe('fresh');
    });
    expect(diagnostic).not.toHaveBeenCalled();

    unsubscribe();
    store.dispose();
  });

  it('keeps the Resource state authoritative when the diagnostic sink throws', async () => {
    const bytes = pngBytes(8, 8, HAPPIER_MAX_RENDERABLE_IMAGE_BYTES + 1);
    const client: PluginUiResourceClient = {
      readResource: vi.fn(async () => imageResource(bytes, 'sha256:big')),
      diagnostic: vi.fn(() => { throw new Error('sink is gone'); }),
    };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('brand');
    const unsubscribe = entry.subscribe(() => undefined, false);

    await vi.waitFor(() => {
      expect(entry.getSnapshot()).toMatchObject({ freshness: 'fresh', pending: 'idle' });
    });
    expect(entry.getSnapshot().error).toBeUndefined();

    unsubscribe();
    store.dispose();
  });
});

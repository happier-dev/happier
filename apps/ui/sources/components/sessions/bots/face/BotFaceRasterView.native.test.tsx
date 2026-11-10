import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { FilterMode, MipmapMode, Skia } from '@shopify/react-native-skia';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { botFaceHeroPose } from './botFaceGeometry';
import { resolveBotFaceIdentity } from './botFaceIdentity';
import { drawBotFaceRaster } from './botFaceRaster';
import { BotFaceRasterView } from './BotFaceRasterView.native';

// Native Skia handles are the system boundary; keep the raster producer and paint adapter real.
vi.mock('@shopify/react-native-skia', async () =>
  (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
);

afterEach(async () => { await standardCleanup(); });

it('paints opaque raster pixels through Skia with their original buffer and sampling', async () => {
  const fromBytes = vi.spyOn(Skia.Data, 'fromBytes');
  const makeImage = vi.spyOn(Skia.Image, 'MakeImage');
  const identity = resolveBotFaceIdentity('native-raster-resource');
  for (const smooth of [false, true]) {
    const image = drawBotFaceRaster({
      style: smooth ? 'solid' : 'pixel', identity, size: 24, dpr: 2, theme: 'dark', mood: 'quiet',
      hero: smooth ? { pose: botFaceHeroPose('quiet', 0, identity.seed, true), t: 0, rest: true } : undefined,
    });
    const screen = await renderScreen(<BotFaceRasterView image={image} size={24} />);
    const pixels = fromBytes.mock.calls.at(-1)?.[0];
    expect(pixels).toBeInstanceOf(Uint8Array);
    expect(pixels?.buffer).toBe(image.data.buffer);
    expect(pixels?.byteOffset).toBe(image.data.byteOffset);
    expect(pixels?.byteLength).toBe(image.data.byteLength);
    expect(pixels).toEqual(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength));
    expect(makeImage.mock.calls.at(-1)?.[0]).toMatchObject({ width: image.width, height: image.height });
    expect(makeImage.mock.calls.at(-1)?.[2]).toBe(image.width * 4);
    const painted = screen.findByType('SkiaImage');
    expect(painted.props.image).toBe(makeImage.mock.results.at(-1)?.value);
    expect(painted.props.sampling).toEqual({ filter: smooth ? FilterMode.Linear : FilterMode.Nearest, mipmap: MipmapMode.None });
  }
});

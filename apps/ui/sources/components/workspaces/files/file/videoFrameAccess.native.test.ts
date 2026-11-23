import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkiaMockBoundary } from '@/dev/testkit/mocks/skia';

/** Native has no DOM: Skia's platform video decoder is the boundary; frame choice and drawing stay real. */
const native = vi.hoisted(() => ({
  boundary: null as SkiaMockBoundary | null,
}));
vi.mock('@shopify/react-native-skia', async () => {
  const { createSkiaModuleMock } = await import('@/dev/testkit/mocks/skia');
  const mock = createSkiaModuleMock();
  native.boundary = mock.boundary;
  return mock.module;
});

await import('@shopify/react-native-skia');
const { readHeldPlayerFrame, withVideoFrameSource } =
  await import('./videoFrameAccess.native');
const decoder = native.boundary!;

describe('video frame access (native)', () => {
  beforeEach(() => {
    Object.assign(decoder, {
      videoOpenable: true,
      videoRotation: 0,
      videoSize: { width: 8, height: 6 },
      videoDurationMs: 60_000,
      emptyPollsAfterSeek: 1,
      encodes: 0,
    });
    decoder.videos.length = 0;
    decoder.log.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the addressed frame as a PNG once the decoder settles, then releases the decoder', async () => {
    const frame = await withVideoFrameSource('file:///clip.mp4', (controls) =>
      controls.readFrame({ timeSeconds: 18 }),
    );
    expect(frame).toEqual({
      uri: 'data:image/png;base64,untouched8x6',
      width: 8,
      height: 6,
      timeSeconds: 18,
      durationSeconds: 60,
    });
    expect(decoder.videos).toEqual([
      { uri: 'file:///clip.mp4', seeks: [18_000], polls: 2, disposed: true },
    ]);
    expect(decoder.encodes).toBe(1);
  });

  it('returns a portrait recording upright at the demanded width', async () => {
    decoder.videoRotation = 90;
    const frame = await withVideoFrameSource(
      'file:///portrait.mp4',
      (controls) => controls.readFrame({ timeSeconds: 2, width: 3 }),
    );
    expect(frame).toMatchObject({ width: 3, height: 4 });
    expect(decoder.log).toContain('rotate 90');
  });

  it('clamps a time past the end to the last frame', async () => {
    await withVideoFrameSource('file:///clip.mp4', (controls) =>
      controls.readFrame({ timeSeconds: 90 }),
    );
    expect(decoder.videos[0]!.seeks).toEqual([60_000]);
  });

  it('stops waiting and releases the decoder when the caller cancels', async () => {
    decoder.emptyPollsAfterSeek = Number.POSITIVE_INFINITY;
    const caller = new AbortController();
    const pending = withVideoFrameSource('file:///clip.mp4', (controls) =>
      controls.readFrame({ timeSeconds: 4, signal: caller.signal }),
    );
    await vi.waitFor(() => expect(decoder.videos[0]?.polls).toBeGreaterThan(1));
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoder.videos[0]!.disposed).toBe(true);
    expect(decoder.encodes).toBe(0);
  });

  it('reads the held player frame at its current position from the same source', async () => {
    const lifetime = new AbortController();
    const frame = await readHeldPlayerFrame({
      element: null,
      uri: 'file:///held.mp4',
      currentTimeSeconds: 7.5,
      options: {},
      lifetime: lifetime.signal,
    });
    expect(frame).toMatchObject({ timeSeconds: 7.5, width: 8, height: 6 });
    expect(decoder.videos).toEqual([
      expect.objectContaining({
        uri: 'file:///held.mp4',
        seeks: [7_500],
        disposed: true,
      }),
    ]);
  });

  it('reports a source the platform decoder cannot open', async () => {
    decoder.videoOpenable = false;
    await expect(
      withVideoFrameSource('file:///broken.mp4', (controls) =>
        controls.readFrame({ timeSeconds: 1 }),
      ),
    ).rejects.toThrow();
    expect(decoder.encodes).toBe(0);
  });
});

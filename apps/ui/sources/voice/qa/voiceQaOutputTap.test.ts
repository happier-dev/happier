import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginVoiceQaOutputTap,
  getVoiceQaOutputTapSnapshot,
  resetVoiceQaOutputTapForTests,
  setVoiceQaOutputTapEnabled,
  subscribeToVoiceQaOutputTap,
} from './voiceQaOutputTap';

describe('voiceQaOutputTap', () => {
  const originalDebug = process.env.EXPO_PUBLIC_DEBUG;
  const originalDev = (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    resetVoiceQaOutputTapForTests();
  });

  afterEach(() => {
    process.env.EXPO_PUBLIC_DEBUG = originalDebug;
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = originalDev;
    resetVoiceQaOutputTapForTests();
    vi.restoreAllMocks();
  });

  it('remains inert until explicitly enabled by the dev QA route', async () => {
    const handle = beginVoiceQaOutputTap({
      bytes: new Uint8Array([1, 2, 3, 4]).buffer,
      format: 'wav',
    });
    handle.markPlaying();
    handle.markCompleted();
    await Promise.resolve();

    expect(getVoiceQaOutputTapSnapshot()).toEqual({
      enabled: false,
      artifact: null,
    });
  });

  it('captures a bounded copy and records playback completion without owning playback', async () => {
    setVoiceQaOutputTapEnabled(true);
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceQaOutputTap(listener);

    const handle = beginVoiceQaOutputTap({
      bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer,
      format: 'wav',
    });
    handle.markPlaying();
    handle.markCompleted();
    await Promise.resolve();

    const snapshot = getVoiceQaOutputTapSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.artifact).toMatchObject({
      format: 'wav',
      originalByteLength: 8,
      capturedByteLength: 8,
      lifecycle: 'completed',
      truncated: false,
    });
    expect(snapshot.artifact?.bytesBase64).toBe('UklGRgECAwQ=');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('records cancellation and caps captured bytes without retaining an unbounded artifact', async () => {
    setVoiceQaOutputTapEnabled(true);
    const bytes = new Uint8Array(1024 * 1024 + 17);
    bytes.fill(7);

    const handle = beginVoiceQaOutputTap({ bytes: bytes.buffer, format: 'wav' });
    handle.markPlaying();
    handle.markCancelled();
    await Promise.resolve();

    expect(getVoiceQaOutputTapSnapshot().artifact).toMatchObject({
      originalByteLength: bytes.byteLength,
      capturedByteLength: 1024 * 1024,
      lifecycle: 'cancelled',
      truncated: true,
    });
  });

  it('cannot be enabled in a production build', () => {
    process.env.EXPO_PUBLIC_DEBUG = '0';
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
    setVoiceQaOutputTapEnabled(true);

    expect(getVoiceQaOutputTapSnapshot()).toEqual({
      enabled: false,
      artifact: null,
    });
  });
});

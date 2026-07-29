import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));

import type { HappierAudioStreamNativeModule } from './HappierAudioStreamNative.types';
import { createSharedVoicePcmCaptureRegistry } from './sharedVoicePcmCapture';

function createNativeModule(): HappierAudioStreamNativeModule {
  return {
    start: vi.fn(async () => ({ streamId: 'stream-1' })),
    stop: vi.fn(async () => undefined),
    configureAudioSession: vi.fn(async ({ generation, configuration }) => ({
      generation,
      aecAvailable: true,
      aecActive: configuration.aec !== 'off',
      route: 'speaker',
    })),
    restoreAudioSession: vi.fn(async () => undefined),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  };
}

describe('shared VoicePcmCapture registry', () => {
  it('returns null and caches the unavailable native boundary for this JS runtime', () => {
    const getNativeModule = vi.fn(() => null);
    const registry = createSharedVoicePcmCaptureRegistry({ getNativeModule });

    expect(registry.get()).toBeNull();
    expect(registry.get()).toBeNull();
    expect(getNativeModule).toHaveBeenCalledTimes(1);
  });

  it('fails closed when optional native lookup throws during runtime initialization', () => {
    const getNativeModule = vi.fn(() => { throw new Error('native registry unavailable'); });
    const registry = createSharedVoicePcmCaptureRegistry({ getNativeModule });

    expect(registry.get()).toBeNull();
    expect(registry.getAudioSessionCoordinator()).toBeNull();
    expect(getNativeModule).toHaveBeenCalledTimes(1);
  });

  it('constructs exactly one coordinator and capture service for all consumers', async () => {
    const nativeModule = createNativeModule();
    const registry = createSharedVoicePcmCaptureRegistry({ getNativeModule: () => nativeModule });

    const first = registry.get();
    const second = registry.get();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(registry.getAudioSessionCoordinator()).toBe(registry.getAudioSessionCoordinator());
    const stt = await first!.acquire({
      ownerId: 'stt',
      format: { sampleRate: 16_000, channels: 1, frameMs: 20 },
      onFrame: () => undefined,
    });
    const vad = await second!.acquire({
      ownerId: 'vad',
      format: { sampleRate: 16_000, channels: 1, frameMs: 20 },
      onFrame: () => undefined,
    });
    expect(nativeModule.start).toHaveBeenCalledTimes(1);
    await stt.release();
    await vad.release();
    expect(nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(nativeModule.restoreAudioSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the installed native module lacks coordinator methods', () => {
    const legacyModule = {
      start: vi.fn(),
      stop: vi.fn(),
      addListener: vi.fn(),
    } as unknown as HappierAudioStreamNativeModule;
    const registry = createSharedVoicePcmCaptureRegistry({ getNativeModule: () => legacyModule });

    expect(registry.get()).toBeNull();
  });

  it('fails closed when a partially installed native module throws during service construction', () => {
    const partialModule = {
      start: vi.fn(async () => ({ streamId: 'stream-1' })),
      stop: vi.fn(async () => undefined),
      configureAudioSession: vi.fn(async ({ generation }: { generation: number }) => ({
        generation,
        aecAvailable: true,
        aecActive: false,
        route: null,
      })),
      restoreAudioSession: vi.fn(async () => undefined),
      // The native installation is corrupt/partial: the event bridge is absent.
      addListener: undefined,
    } as unknown as HappierAudioStreamNativeModule;
    const registry = createSharedVoicePcmCaptureRegistry({ getNativeModule: () => partialModule });

    expect(() => registry.get()).not.toThrow();
    expect(registry.get()).toBeNull();
    expect(registry.getAudioSessionCoordinator()).toBeNull();
  });
});

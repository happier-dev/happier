import { afterEach, describe, expect, it } from 'vitest';

import { isVoiceQaDebugRuntime } from './voiceQaDebugRuntime';

describe('isVoiceQaDebugRuntime', () => {
  const originalDebug = process.env.EXPO_PUBLIC_DEBUG;
  const originalDev = (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__;

  afterEach(() => {
    process.env.EXPO_PUBLIC_DEBUG = originalDebug;
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = originalDev;
  });

  it('enables the QA seam in an explicitly debug build', () => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
    expect(isVoiceQaDebugRuntime()).toBe(true);
  });

  it('enables the QA seam in the managed development stack', () => {
    process.env.EXPO_PUBLIC_DEBUG = '0';
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;
    expect(isVoiceQaDebugRuntime()).toBe(true);
  });

  it('fails closed in a production runtime', () => {
    process.env.EXPO_PUBLIC_DEBUG = '0';
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
    expect(isVoiceQaDebugRuntime()).toBe(false);
  });
});

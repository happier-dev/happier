import { describe, expect, it, vi } from 'vitest';

import type { TerminalNativeModule } from './HappierTerminalNative.types';
import {
  getTerminalNativeQaCapabilities,
  injectTerminalNativeRendererCrashForQa,
} from './qa';

describe('terminal native QA fault injection', () => {
  it('fails closed when the native build does not explicitly advertise the QA capability', async () => {
    const qaInjectRendererCrash = vi.fn();
    const nativeModule = {
      getAvailability: vi.fn(),
      getQaCapabilities: () => ({ rendererCrashInjection: false }),
      qaInjectRendererCrash,
    } satisfies TerminalNativeModule;

    expect(getTerminalNativeQaCapabilities(nativeModule)).toEqual({ rendererCrashInjection: false });
    await expect(injectTerminalNativeRendererCrashForQa('surface', nativeModule)).resolves.toEqual({
      injected: false,
      reason: 'qa-disabled',
    });
    expect(qaInjectRendererCrash).not.toHaveBeenCalled();
  });

  it('targets one non-empty active surface only after native capability approval', async () => {
    const qaInjectRendererCrash = vi.fn(async (surfaceId: string) => ({ injected: true, surfaceId }));
    const nativeModule = {
      getAvailability: vi.fn(),
      getQaCapabilities: () => ({ rendererCrashInjection: true }),
      qaInjectRendererCrash,
    } satisfies TerminalNativeModule;

    expect(getTerminalNativeQaCapabilities(nativeModule)).toEqual({ rendererCrashInjection: true });
    await expect(injectTerminalNativeRendererCrashForQa(' surface-1 ', nativeModule)).resolves.toEqual({
      injected: true,
      surfaceId: 'surface-1',
    });
    expect(qaInjectRendererCrash).toHaveBeenCalledWith('surface-1');
  });

  it('rejects blank surface ids and malformed native responses', async () => {
    const qaInjectRendererCrash = vi.fn(async () => ({ injected: true, surfaceId: 'other-surface' }));
    const nativeModule = {
      getAvailability: vi.fn(),
      getQaCapabilities: () => ({ rendererCrashInjection: true }),
      qaInjectRendererCrash,
    } satisfies TerminalNativeModule;

    await expect(injectTerminalNativeRendererCrashForQa(' ', nativeModule)).resolves.toEqual({
      injected: false,
      reason: 'surface-not-ready',
    });
    await expect(injectTerminalNativeRendererCrashForQa('surface-1', nativeModule)).resolves.toEqual({
      injected: false,
      reason: 'invalid-response',
    });
  });
});

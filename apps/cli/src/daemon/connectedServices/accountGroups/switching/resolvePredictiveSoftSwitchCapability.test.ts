import { describe, expect, it, vi } from 'vitest';

import { resolvePredictiveSoftSwitchCapability } from './resolvePredictiveSoftSwitchCapability';

describe('resolvePredictiveSoftSwitchCapability', () => {
  it('lets a declared unsupported descriptor outrank runtime-auth adapter inference', async () => {
    const inferFromRuntimeAuthAdapter = vi.fn(async () => 'supported' as const);

    await expect(resolvePredictiveSoftSwitchCapability({
      declaredCapabilities: { predictiveSoftSwitch: { mode: 'unsupported' } },
      inferFromRuntimeAuthAdapter,
    })).resolves.toBe('unsupported');
    expect(inferFromRuntimeAuthAdapter).not.toHaveBeenCalled();
  });

  it('lets a declared supported descriptor short-circuit inference', async () => {
    const inferFromRuntimeAuthAdapter = vi.fn(async () => 'unsupported' as const);

    await expect(resolvePredictiveSoftSwitchCapability({
      declaredCapabilities: { predictiveSoftSwitch: { mode: 'supported' } },
      inferFromRuntimeAuthAdapter,
    })).resolves.toBe('supported');
    expect(inferFromRuntimeAuthAdapter).not.toHaveBeenCalled();
  });

  it('keeps legacy adapter inference for providers without a declared descriptor', async () => {
    await expect(resolvePredictiveSoftSwitchCapability({
      declaredCapabilities: null,
      inferFromRuntimeAuthAdapter: async () => 'supported',
    })).resolves.toBe('supported');

    await expect(resolvePredictiveSoftSwitchCapability({
      declaredCapabilities: null,
      inferFromRuntimeAuthAdapter: async () => 'unsupported',
    })).resolves.toBe('unsupported');
  });

  it('fails closed to unsupported when inference throws', async () => {
    await expect(resolvePredictiveSoftSwitchCapability({
      declaredCapabilities: null,
      inferFromRuntimeAuthAdapter: async () => {
        throw new Error('adapter unavailable');
      },
    })).resolves.toBe('unsupported');
  });
});

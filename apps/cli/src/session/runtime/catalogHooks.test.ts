import { describe, expect, it } from 'vitest';

import {
  getVendorResumeSupport,
  resolveProviderSessionRuntimePreferences,
} from './catalogHooks';

describe('session runtime catalog hooks', () => {
  it('resolves provider runtime preferences from catalog entries', async () => {
    await expect(resolveProviderSessionRuntimePreferences('kilo', {
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      pluginSettings: {},
      environment: {},
      startOrigin: 'terminal',
    })).resolves.toEqual({});
  });

  it('keeps runtime-checked experimental vendor resume providers enabled', async () => {
    const ohMyPiSupportsResume = await getVendorResumeSupport('ohMyPi');
    const supportsResume = await getVendorResumeSupport('cursor');
    const kiroSupportsResume = await getVendorResumeSupport('kiro');

    expect(ohMyPiSupportsResume({})).toBe(true);
    expect(supportsResume({})).toBe(true);
    expect(kiroSupportsResume({})).toBe(false);
  });
});

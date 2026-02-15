import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '../types';
import { getProviderCliInstallSpec } from './cliInstallSpecs';

describe('provider CLI install specs', () => {
  it('defines an install spec for every agent id', () => {
    for (const id of AGENT_IDS) {
      const spec = getProviderCliInstallSpec(id);
      expect(spec.id).toBe(id);
      expect(Array.isArray(spec.binaries)).toBe(true);
      expect(spec.binaries.length).toBeGreaterThan(0);
    }
  });

  it('includes correct upstream install hints for known providers', () => {
    expect(JSON.stringify(getProviderCliInstallSpec('claude'))).toContain('claude.ai/install.sh');
    expect(JSON.stringify(getProviderCliInstallSpec('opencode'))).toContain('opencode.ai/install');
    expect(JSON.stringify(getProviderCliInstallSpec('kimi'))).toContain('code.kimi.com/install.sh');
    expect(JSON.stringify(getProviderCliInstallSpec('qwen'))).toContain('install-qwen');
    expect(JSON.stringify(getProviderCliInstallSpec('auggie'))).toContain('@augmentcode/auggie');
    expect(JSON.stringify(getProviderCliInstallSpec('kilo'))).toContain('@kilocode/cli');
    expect(JSON.stringify(getProviderCliInstallSpec('pi'))).toContain('@mariozechner/pi-coding-agent');
  });
});


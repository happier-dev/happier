import { describe, expect, it } from 'vitest';

import * as acpModule from './acp.js';
import { BUILT_IN_ACP_CONFIG, getBuiltInAcpConfig, hasBuiltInAcpConfig } from './acp.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import { getAgentCliRuntimeSpec } from './cli/runtime.js';

describe('built-in ACP config', () => {
  it('keeps the built-in ACP allowlist explicit and drift-free', () => {
    expect(Object.keys(BUILT_IN_ACP_CONFIG).sort()).toEqual(['ohMyPi']);
  });

  it('sources built-in ACP metadata from bundled provider definitions', () => {
    expect(getBuiltInAcpConfig('ohMyPi')).toBe(BUNDLED_AGENT_DEFINITIONS_BY_ID.ohMyPi.builtInAcpConfig);
  });

  it('does not expose legacy Custom ACP through the canonical built-in ACP config', () => {
    expect('LEGACY_CUSTOM_ACP_COMPAT_CONFIG' in acpModule).toBe(false);
    expect(hasBuiltInAcpConfig('customAcp')).toBe(false);
    expect(getBuiltInAcpConfig('customAcp')).toBeNull();
  });

  it('leaves Kiro ACP runtime ownership to the Kiro plugin contribution', () => {
    expect(hasBuiltInAcpConfig('kiro')).toBe(false);
    expect(getBuiltInAcpConfig('kiro')).toBeNull();
  });

  it('exposes ohMyPi as a built-in generic ACP agent with explicit session/model/image capabilities', () => {
    expect(hasBuiltInAcpConfig('ohMyPi')).toBe(true);
    expect(getBuiltInAcpConfig('ohMyPi')).toMatchObject({
      agentId: 'ohMyPi',
      launcher: {
        command: getAgentCliRuntimeSpec('ohMyPi').binaryName,
        args: ['--mode', 'acp'],
      },
      transportProfile: 'generic',
      supportsLoadSession: true,
      supportsModes: 'yes',
      supportsModels: 'yes',
      promptImageSupport: 'yes',
    });
  });

  it('does not mark non-ACP shell-bridge providers as built-in ACP', () => {
    expect(hasBuiltInAcpConfig('gemini')).toBe(false);
    expect(hasBuiltInAcpConfig('pi')).toBe(false);
  });
});

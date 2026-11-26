import { describe, expect, it } from 'vitest';
import { resolveClaudeCodeModeEligibility } from './codeModeEligibility.js';

const input = {
  sessionsCodeModeEnabled: true,
  runtimeKind: 'unifiedTerminal',
  launchEnv: {},
  claudeCodeModeEnabled: true,
} as const;
const resumeDescriptor = { v: 1, agentId: 'claude', agent: { codeModeActive: true } } as const;

describe('Claude native Code Mode eligibility', () => {
  it.each([
    [{ unlistedTools: 'deny', resumeDescriptor }, false, 'confined'],
    [{ resumeDescriptor, claudeCodeModeEnabled: false, sessionsCodeModeEnabled: false }, true, 'resume_locked'],
    [{ sessionsCodeModeEnabled: false }, false, 'feature_disabled'],
    [{ runtimeKind: 'agentSdk' }, false, 'requires_unified_terminal'],
    [{ launchEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example' } }, false, 'custom_gateway_unsupported'],
    [{ launchEnv: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' } }, true, 'enabled'],
    [{ claudeCodeModeEnabled: false }, false, 'disabled'],
  ] as const)('resolves %j as %s (%s)', (overrides, active, reason) => {
    expect(resolveClaudeCodeModeEligibility({ ...input, ...overrides })).toEqual({ active, reason });
  });

  it.each(['BEDROCK', 'VERTEX', 'FOUNDRY'])('accepts the %s provider with its API base', provider => {
    expect(resolveClaudeCodeModeEligibility({ ...input, launchEnv: {
      ANTHROPIC_BASE_URL: 'https://provider.example',
      [`CLAUDE_CODE_USE_${provider}`]: '1',
    } })).toEqual({ active: true, reason: 'enabled' });
  });
});

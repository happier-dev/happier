import type { RuntimeDescriptorV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { readClaudeRuntimeDescriptorAgent } from './terminal/unified/selection.js';

export const CLAUDE_CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';
export const CLAUDE_CODE_MODE_TOOL = 'REPL';

export function resolveClaudeCodeModeEligibility(input: Readonly<{
  unlistedTools?: 'ask' | 'deny';
  resumeDescriptor?: RuntimeDescriptorV1;
  sessionsCodeModeEnabled?: boolean;
  runtimeKind: 'agentSdk' | 'unifiedTerminal';
  launchEnv: Readonly<Record<string, string | undefined>>;
  claudeCodeModeEnabled: boolean;
}>) {
  if (input.unlistedTools === 'deny') return { active: false, reason: 'confined' } as const;
  if (readClaudeRuntimeDescriptorAgent(input.resumeDescriptor)?.codeModeActive === true) {
    return { active: true, reason: 'resume_locked' } as const;
  }
  if (input.sessionsCodeModeEnabled !== true) return { active: false, reason: 'feature_disabled' } as const;
  if (input.runtimeKind !== 'unifiedTerminal') return { active: false, reason: 'requires_unified_terminal' } as const;
  const env = input.launchEnv;
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, '');
  const cloudProvider = [env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX, env.CLAUDE_CODE_USE_FOUNDRY]
    .some(value => value !== undefined && /^(?:1|true|yes|on)$/i.test(value.trim()));
  if (baseUrl && baseUrl !== 'https://api.anthropic.com' && !cloudProvider) {
    return { active: false, reason: 'custom_gateway_unsupported' } as const;
  }
  return input.claudeCodeModeEnabled
    ? { active: true, reason: 'enabled' } as const
    : { active: false, reason: 'disabled' } as const;
}

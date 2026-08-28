import { describe, expect, it } from 'vitest';

import {
  resolveClaudeExternalSandboxEnv,
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeUnifiedTerminalLaunchEnvironment,
} from './launchSettings.js';

describe('Claude launch environment', () => {
  it('recognizes only Claude\'s exact external sandbox assertion', () => {
    expect(resolveClaudeExternalSandboxEnv({ IS_SANDBOX: '1' })).toEqual({
      IS_SANDBOX: '1',
    });
    expect(resolveClaudeExternalSandboxEnv({ IS_SANDBOX: '0' })).toEqual({});
    expect(resolveClaudeExternalSandboxEnv({})).toEqual({});
  });

  it('inherits the sandbox assertion unless the launch environment overrides or unsets it', () => {
    expect(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: { values: {}, unset: [] },
      processEnv: { IS_SANDBOX: '1' },
    })).toEqual({ IS_SANDBOX: '1' });

    expect(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: { values: { IS_SANDBOX: '0' }, unset: [] },
      processEnv: { IS_SANDBOX: '1' },
    })).toEqual({ IS_SANDBOX: '0' });

    expect(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: { values: {}, unset: ['IS_SANDBOX'] },
      processEnv: { IS_SANDBOX: '1' },
    })).toEqual({});
  });

  it('disables Claude prompt suggestions for unified terminals even when the launch environment enables them', () => {
    expect(resolveClaudeUnifiedTerminalLaunchEnvironment({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'true',
    })).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    });
  });
});

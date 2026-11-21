import { describe, expect, it } from 'vitest';

import {
  resolveClaudeExternalSandboxEnv,
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeUnifiedTerminalLaunchEnvironment,
} from './launchSettings.js';

describe('Claude launch environment', () => {
  it('uses the host inherited environment without falling back when a Session selector is absent', () => {
    expect(resolveClaudeNativeBaseLaunchEnvironment({ launchEnvironment: { values: {}, unset: [] },
      exec: { readEnvironment: () => ({}) },
    })).toEqual({});
    expect(resolveClaudeNativeBaseLaunchEnvironment({ launchEnvironment: { values: {}, unset: [] },
      processEnv: { USER: 'explicit-baseline' }, exec: { readEnvironment: () => ({ USER: 'session-user' }) },
    })).toEqual({ USER: 'explicit-baseline' });
  });

  it('reports an unavailable host environment instead of consulting the physical process', () => {
    expect(() => resolveClaudeNativeBaseLaunchEnvironment({ exec: {} }))
      .toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
  });

  it('launches Claude in the Session host’s selected config directory', () => {
    const inherited = { HAPPIER_CLAUDE_CONFIG_DIR: '/fixture/claude' };
    const exec = {
      readEnvironment: (keys: readonly string[]) => Object.fromEntries(
        Object.entries(inherited).filter(([key]) => keys.includes(key)),
      ),
    };
    expect(resolveClaudeNativeBaseLaunchEnvironment({ exec })).toEqual({
      CLAUDE_CONFIG_DIR: '/fixture/claude',
    });
    expect(resolveClaudeNativeBaseLaunchEnvironment({
      exec,
      launchEnvironment: { values: { CLAUDE_CONFIG_DIR: '/admitted/claude' }, unset: [] },
    })).toEqual({ CLAUDE_CONFIG_DIR: '/admitted/claude' });
    expect(resolveClaudeNativeBaseLaunchEnvironment({
      exec,
      launchEnvironment: { values: {}, unset: ['CLAUDE_CONFIG_DIR'] },
    })).toEqual({});
  });

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

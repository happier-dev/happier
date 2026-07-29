import { describe, expect, it, vi } from 'vitest';

import {
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeNativeLaunchSettings,
} from './launchSettings.js';

describe('resolveClaudeNativeLaunchSettings', () => {
  it('inherits the host user identity required by local Claude auth unless explicitly unset', () => {
    expect(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: {
        values: { CLAUDE_CONFIG_DIR: '/tmp/claude-config' },
        unset: [],
      },
      processEnv: {
        USER: 'local-claude-user',
      },
    })).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      USER: 'local-claude-user',
    });

    expect(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: {
        values: { CLAUDE_CONFIG_DIR: '/tmp/claude-config' },
        unset: ['USER'],
      },
      processEnv: {
        USER: 'local-claude-user',
      },
    })).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
    });
  });

  it('keeps an explicit launch user identity authoritative over the host default', () => {
    expect(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: {
        values: { USER: 'explicit-claude-user' },
        unset: [],
      },
      processEnv: {
        USER: 'local-claude-user',
      },
    })).toEqual({
      USER: 'explicit-claude-user',
    });
  });

  it('restores released same-key account values into the native Claude launch', async () => {
    const get = vi.fn(async (key: string) => {
      if (key === 'claudeCodeExperimentalAgentTeamsEnabled') return true;
      if (key === 'claudeRemoteAdvancedOptionsJson') {
        return JSON.stringify({
          plugins: [{ type: 'local', path: '/tmp/plugin' }],
          maxTurns: 999,
        });
      }
      return null;
    });

    await expect(resolveClaudeNativeLaunchSettings({
      settings: { get },
      launchEnv: { EXISTING_ENV: 'kept' },
      includeAdvancedOptions: true,
    })).resolves.toEqual({
      launchEnv: {
        EXISTING_ENV: 'kept',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
      advancedOptions: {
        plugins: [{ type: 'local', path: '/tmp/plugin' }],
      },
    });
    expect(get).toHaveBeenCalledWith('claudeCodeExperimentalAgentTeamsEnabled');
    expect(get).toHaveBeenCalledWith('claudeRemoteAdvancedOptionsJson');
  });

  it('leaves explicit launch state unchanged when settings are absent or malformed', async () => {
    const launchEnv = {
      EXISTING_ENV: 'kept',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 'caller-owned',
    };
    await expect(resolveClaudeNativeLaunchSettings({
      settings: { get: vi.fn(async () => 'not-enabled') },
      launchEnv,
      includeAdvancedOptions: false,
    })).resolves.toEqual({
      launchEnv,
      advancedOptions: {},
    });
  });
});

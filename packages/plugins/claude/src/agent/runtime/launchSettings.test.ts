import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveClaudeLaunchSettingsOverlayArgs,
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeNativeLaunchSettings,
} from './launchSettings.js';

describe('resolveClaudeNativeLaunchSettings', () => {
  it('acknowledges bypass mode only for interactive terminal launches', () => {
    expect(resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'interactive_terminal',
      permissionMode: 'bypassPermissions',
      launchSettings: {},
    })).toEqual([
      '--model',
      'sonnet',
      '--settings',
      JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    ]);

    expect(resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'interactive_terminal',
      permissionMode: 'default',
      launchSettings: {},
    })).toEqual(['--model', 'sonnet']);

    expect(resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'noninteractive_sdk',
      permissionMode: 'bypassPermissions',
      launchSettings: {},
    })).toEqual(['--model', 'sonnet']);
  });

  it('merges the interactive acknowledgement into the single existing launch overlay', () => {
    expect(resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--settings', JSON.stringify({ ultracode: true })],
      interactionKind: 'interactive_terminal',
      permissionMode: 'bypassPermissions',
      launchSettings: {
        statusLine: { type: 'command', command: 'status-forwarder' },
      },
    })).toEqual([
      '--settings',
      JSON.stringify({
        ultracode: true,
        statusLine: { type: 'command', command: 'status-forwarder' },
        skipDangerousModePermissionPrompt: true,
      }),
    ]);
  });

  it('reads file-backed settings into the inline launch overlay without creating a sibling file', async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), 'happier-claude-launch-settings-'));
    const settingsPath = join(settingsDir, 'settings.json');
    const sourceSettings = { permissions: { allow: ['mcp__happier__change_title'] } };
    await writeFile(settingsPath, JSON.stringify(sourceSettings));

    try {
      expect(resolveClaudeLaunchSettingsOverlayArgs({
        args: ['--settings', settingsPath],
        interactionKind: 'interactive_terminal',
        permissionMode: 'bypassPermissions',
        launchSettings: {},
      })).toEqual([
        '--settings',
        JSON.stringify({
          ...sourceSettings,
          skipDangerousModePermissionPrompt: true,
        }),
      ]);
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(sourceSettings);
      expect(await readdir(settingsDir)).toEqual(['settings.json']);
    } finally {
      await rm(settingsDir, { recursive: true, force: true });
    }
  });

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

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveClaudeLaunchSettingsOverlayArgs,
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeNativeLaunchSettings,
} from './launchSettings.js';

const titlePermissions = {
  allow: ['mcp__happier__change_title', 'mcp__happier__session_title_set'],
};

describe('resolveClaudeNativeLaunchSettings', () => {
  it.each(['interactive_terminal', 'noninteractive_sdk'] as const)(
    'denies native workspace writes under bypass for %s while keeping Happier tools available',
    (interactionKind) => {
      const args = resolveClaudeLaunchSettingsOverlayArgs({
        args: ['--settings', JSON.stringify({ permissions: { deny: ['WebFetch'], allow: ['Read'] } })],
        interactionKind,
        permissionMode: 'bypassPermissions',
        launchSettings: {},
        workspaceWrites: 'deny',
      });
      const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
      expect(settings.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'Edit', 'Write', 'NotebookEdit', 'Bash']));
      expect(settings.permissions.deny).not.toContain('mcp__happier__*');
      expect(settings.permissions.allow).toContain('Read');
    },
  );

  it('includes the Happier title tools in the interactive launch allow rules', () => {
    const args = resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'interactive_terminal',
      permissionMode: 'default',
      launchSettings: {},
    });
    const settingsIndex = args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(args[settingsIndex + 1] ?? '{}');
    expect(settings.permissions?.allow).toEqual(expect.arrayContaining([
      'mcp__happier__change_title',
      'mcp__happier__session_title_set',
    ]));
  });

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
      JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: titlePermissions }),
    ]);

    expect(resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'interactive_terminal',
      permissionMode: 'default',
      launchSettings: {},
    })).toEqual(['--model', 'sonnet', '--settings', JSON.stringify({ permissions: titlePermissions })]);

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
        permissions: titlePermissions,
      }),
    ]);
  });

  it('reads file-backed settings into the inline launch overlay without creating a sibling file', async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), 'happier-claude-launch-settings-'));
    const settingsPath = join(settingsDir, 'settings.json');
    const sourceSettings = { permissions: {
      allow: ['mcp__happier__change_title'],
      deny: ['Bash'],
    } };
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
          permissions: { ...titlePermissions, deny: ['Bash'] },
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
      if (key === 'claudeRemoteSettingSourcesV2') return ['project'];
      if (key === 'claudeRemoteAdvancedOptionsJson') {
        return JSON.stringify({
          plugins: [{ type: 'local', path: '/tmp/plugin' }],
          maxTurns: 999,
        });
      }
      return null;
    });

    await expect(resolveClaudeNativeLaunchSettings({
      settings: { get, snapshot: async () => ({ values: { claudeRemoteSettingSourcesV2: ['project'] } }) },
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
      settingSources: ['project'],
    });
    expect(get).toHaveBeenCalledWith('claudeCodeExperimentalAgentTeamsEnabled');
    expect(get).toHaveBeenCalledWith('claudeRemoteAdvancedOptionsJson');
  });

  it('preserves an explicitly empty settings-source selection', async () => {
    await expect(resolveClaudeNativeLaunchSettings({
      settings: {
        get: async (key) => key === 'claudeRemoteSettingSourcesV2' ? [] : null,
        snapshot: async () => ({ values: { claudeRemoteSettingSourcesV2: [] } }),
      },
      launchEnv: {},
      includeAdvancedOptions: false,
    })).resolves.toMatchObject({ settingSources: [] });
  });

  it('resolves stored legacy source selection before declaration defaults', async () => {
    await expect(resolveClaudeNativeLaunchSettings({
      settings: {
        get: async (key) => key === 'claudeRemoteSettingSourcesV2' ? ['user', 'project', 'local'] : null,
        snapshot: async () => ({ values: { claudeRemoteSettingSources: 'none' } }),
      },
      launchEnv: {},
      includeAdvancedOptions: false,
    })).resolves.toMatchObject({ settingSources: [] });
  });

  it('leaves explicit launch state unchanged when settings are absent or malformed', async () => {
    const launchEnv = {
      EXISTING_ENV: 'kept',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 'caller-owned',
    };
    await expect(resolveClaudeNativeLaunchSettings({
      settings: { get: vi.fn(async () => 'not-enabled'), snapshot: async () => ({ values: {} }) },
      launchEnv,
      includeAdvancedOptions: false,
    })).resolves.toEqual({
      launchEnv,
      advancedOptions: {},
      settingSources: ['user', 'project', 'local'],
    });
  });
});

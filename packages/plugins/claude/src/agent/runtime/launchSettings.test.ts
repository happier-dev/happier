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
  it.each(['inline', 'equals', 'file'] as const)('maps the resolved idle preference through one %s settings overlay', async (form) => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-idle-settings-'));
    const settingsPath = join(directory, 'settings.json');
    const base = { idleCompaction: 'previous', env: { KEEP: 'yes' }, permissions: { deny: ['WebFetch'] } };
    await writeFile(settingsPath, JSON.stringify(base));
    try {
      for (const enabled of [true, false]) {
        const inputArgs = form === 'file' ? ['--settings', settingsPath]
          : form === 'equals' ? [`--settings=${JSON.stringify(base)}`] : ['--settings', JSON.stringify(base)];
        const args = resolveClaudeLaunchSettingsOverlayArgs({ args: inputArgs,
          interactionKind: 'interactive_terminal', permissionMode: 'default', launchSettings: {},
          idleCompaction: { enabled, minContextTokens: 75_000 },
        });
        expect(args.filter(arg => arg === '--settings' || arg.startsWith('--settings='))).toHaveLength(1);
        expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({
          idleCompaction: enabled, env: { KEEP: 'yes' }, permissions: { deny: ['WebFetch'] },
        });
      }
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(base);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([undefined, 75_000, 200_000, 350_000])('delivers the resolved minimum %s without applying a native clamp', async (minContextTokens) => {
    const result = await resolveClaudeNativeLaunchSettings({
      settings: { get: () => null, snapshot: async () => ({ values: {} }) },
      launchEnv: { KEEP: 'yes', CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: 'existing' },
      includeAdvancedOptions: false, idleCompaction: { enabled: true, ...(minContextTokens === undefined ? {} : { minContextTokens }) },
    });
    expect(result.launchEnv).toEqual({ KEEP: 'yes', CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: minContextTokens === undefined ? 'existing' : String(minContextTokens) });
  });

  it.each(['interactive_terminal', 'noninteractive_sdk'] as const)(
    'projects MCP Off and Ask into the existing overlay without irrevocable Allow for %s',
    (interactionKind) => {
      const args = resolveClaudeLaunchSettingsOverlayArgs({
        args: ['--settings', JSON.stringify({ permissions: { allow: ['Read', 'mcp__linear__write'], deny: ['WebFetch'] } })],
        interactionKind, permissionMode: 'bypassPermissions', launchSettings: {},
        mcpToolPolicy: {
          linear: { unlisted: 'ask', tools: { write: 'off', read: 'allow', inspect: 'ask' } },
          locked: { unlisted: 'deny', tools: {} },
          happier: { unlisted: 'deny', tools: { change_title: 'off' } },
        },
      });
      const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
      expect(settings.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'mcp__linear__write', 'mcp__locked__*']));
      expect(settings.permissions.ask).toEqual(expect.arrayContaining(['mcp__linear__*', 'mcp__linear__read', 'mcp__linear__inspect']));
      expect(settings.permissions.allow).not.toContain('mcp__linear__write');
      expect(settings.permissions.allow).not.toContain('mcp__linear__read');
      expect(settings.permissions.deny).not.toContain('mcp__happier__*');
      expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
    },
  );
  it.each(['interactive_terminal', 'noninteractive_sdk'] as const)(
    'merges native skill disables key-wise into the one settings overlay for %s',
    (interactionKind) => {
      const args = resolveClaudeLaunchSettingsOverlayArgs({
        args: ['--settings', JSON.stringify({ skillOverrides: { retained: 'on', blocked: 'on' }, env: { KEEP: 'yes' } })],
        interactionKind,
        permissionMode: 'default',
        launchSettings: { skillOverrides: { fromLaunch: 'on' } },
        skillOverrides: { blocked: 'off' },
      });
      expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
      expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({
        skillOverrides: { retained: 'on', fromLaunch: 'on', blocked: 'off' }, env: { KEEP: 'yes' },
      });
    },
  );
  it.each([false, true])('uses opt-in Happier attribution for terminal and SDK launch settings (%s)', async (includeAdvancedOptions) => {
    for (const value of [undefined, false, 'true', true]) {
      const launchEnv = { EXISTING_ENV: 'kept' };
      const result = await resolveClaudeNativeLaunchSettings({
        settings: {
          get: (key) => key === 'claudeCodeIncludeInNativeHistory' ? value : undefined,
          snapshot: async () => ({ values: {} }),
        },
        launchEnv,
        includeAdvancedOptions,
      });
      expect(result.launchEnv).toEqual(value === true
        ? { ...launchEnv, CLAUDE_CODE_ENTRYPOINT: 'happier' } : launchEnv);
      expect(launchEnv).toEqual({ EXISTING_ENV: 'kept' });
    }
  });

  it.each([null, 'https://external.example.test'])(
    'extracts only helper pins from the existing managed launch environment for %s',
    async (normalizedUrl) => {
      const result = await resolveClaudeNativeLaunchSettings({
        settings: { get: () => null, snapshot: async () => ({ values: {} }) },
        launchEnv: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'managed-helper',
          ANTHROPIC_AUTH_TOKEN: 'never-copy-to-settings',
        },
        includeAdvancedOptions: false,
        providerBinding: {
          upstream: { protocol: 'anthropic', normalizedUrl, credential: 'apiKey' },
        },
      });
      expect(result.helperModelEnv).toEqual(normalizedUrl === null
        ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'managed-helper' }
        : undefined);
    },
  );

  it.each(['interactive_terminal', 'noninteractive_sdk'] as const)(
    'keeps managed helper pins in one scoped settings overlay without changing definitions for %s',
    (interactionKind) => {
      const definitions = { reviewer: { description: 'Review changes', model: 'explicit-full-model-id', prompt: 'Review carefully' } };
      const helperModelEnv = {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'selected-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'explicit-default',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'selected-model',
      };
      const args = resolveClaudeLaunchSettingsOverlayArgs({
        args: ['--agents', JSON.stringify(definitions), '--settings', JSON.stringify({
          env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'native-file-pin', UNRELATED: 'preserved' },
        })],
        interactionKind,
        permissionMode: 'default',
        launchSettings: {},
        helperModelEnv,
      });
      expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
      const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
      expect(settings.env).toEqual({ ...helperModelEnv, UNRELATED: 'preserved' });
      expect(JSON.parse(args[args.indexOf('--agents') + 1] ?? '{}')).toEqual(definitions);
    },
  );

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
    const acknowledged = resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'interactive_terminal',
      permissionMode: 'bypassPermissions',
      launchSettings: {},
    });
    expect(acknowledged.slice(0, 3)).toEqual(['--model', 'sonnet', '--settings']);
    expect(JSON.parse(acknowledged[3])).toMatchObject({ skipDangerousModePermissionPrompt: true });

    const ordinary = resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'interactive_terminal',
      permissionMode: 'default',
      launchSettings: {},
    });
    expect(ordinary.slice(0, 3)).toEqual(['--model', 'sonnet', '--settings']);
    expect(JSON.parse(ordinary[3])).not.toHaveProperty('skipDangerousModePermissionPrompt');

    expect(resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--model', 'sonnet'],
      interactionKind: 'noninteractive_sdk',
      permissionMode: 'bypassPermissions',
      launchSettings: {},
    })).toEqual(['--model', 'sonnet']);
  });

  it('merges the interactive acknowledgement into the single existing launch overlay', () => {
    const args = resolveClaudeLaunchSettingsOverlayArgs({
      args: ['--settings', JSON.stringify({ ultracode: true })],
      interactionKind: 'interactive_terminal',
      permissionMode: 'bypassPermissions',
      launchSettings: {
        statusLine: { type: 'command', command: 'status-forwarder' },
      },
    });
    expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({
        ultracode: true,
        statusLine: { type: 'command', command: 'status-forwarder' },
        skipDangerousModePermissionPrompt: true,
    });
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
      const args = resolveClaudeLaunchSettingsOverlayArgs({
        args: ['--settings', settingsPath],
        interactionKind: 'interactive_terminal',
        permissionMode: 'bypassPermissions',
        launchSettings: {},
      });
      expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
      expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({
          permissions: { allow: expect.arrayContaining(['mcp__happier__change_title']), deny: ['Bash'] },
          skipDangerousModePermissionPrompt: true,
      });
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

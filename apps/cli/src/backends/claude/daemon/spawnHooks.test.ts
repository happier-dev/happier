import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY } from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const envKeys = ['PATH', 'HAPPIER_CLAUDE_PATH', 'HOME', 'HAPPIER_HOME_DIR', 'CLAUDE_CONFIG_DIR', 'HAPPIER_CLAUDE_CONFIG_DIR', 'IS_SANDBOX'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

afterEach(async () => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  vi.resetModules();
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('claudeDaemonSpawnHooks.resolveTerminalPresentation', () => {
  it('keeps the admitted unified selection after account defaults change', async () => {
    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    for (const pinned of [true, false]) {
      const selected = claudeDaemonSpawnHooks.resolveTerminalPresentation!({
        host: 'tmux', runtimeSelection: {}, processEnv: {},
        accountSettings: accountSettingsParse({ claudeUnifiedTerminalEnabled: pinned }),
      });
      expect(claudeDaemonSpawnHooks.resolveTerminalPresentation!({
        host: 'tmux', runtimeSelection: {}, processEnv: selected.childEnv ?? {},
        accountSettings: accountSettingsParse({ claudeUnifiedTerminalEnabled: !pinned }),
      }).kind).toBe(selected.kind);
    }
  });
  it('uses the current Herdr pane for unified Claude while preserving detached hosts elsewhere', async () => {
    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const selection = { host: 'herdr' as const, runtimeSelection: {}, processEnv: {} };
    expect(claudeDaemonSpawnHooks.resolveTerminalPresentation?.({
      ...selection,
      accountSettings: accountSettingsParse({ claudeUnifiedTerminalEnabled: true }),
    })).toMatchObject({
      kind: 'runner',
      startingMode: 'local',
      childEnv: { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' },
    });
    expect(claudeDaemonSpawnHooks.resolveTerminalPresentation?.({
      host: 'tmux',
      runtimeSelection: {},
      processEnv: {},
      accountSettings: accountSettingsParse({ claudeUnifiedTerminalEnabled: true }),
    })).toMatchObject({ kind: 'provider', childEnv: { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' } });
    expect(claudeDaemonSpawnHooks.resolveTerminalPresentation?.({
      ...selection,
      accountSettings: accountSettingsParse({ claudeUnifiedTerminalEnabled: false }),
    })).toMatchObject({ kind: 'runner', startingMode: 'remote', childEnv: { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '0' } });
  });

  it('keeps a recoverable unified provider in its existing host after account settings change', async () => {
    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect(claudeDaemonSpawnHooks.resolveTerminalPresentation?.({
      host: 'herdr',
      accountSettings: accountSettingsParse({ claudeUnifiedTerminalEnabled: false }),
      runtimeSelection: {},
      processEnv: { [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: '{"attachmentId":"existing"}' },
    })).toMatchObject({ kind: 'provider', childEnv: { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' } });
  });
});

describe('claudeDaemonSpawnHooks', () => {
  it('does not expose legacy generic token auth plumbing', async () => {
    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect('buildAuthEnv' in claudeDaemonSpawnHooks).toBe(false);
  });
});

describe('claudeDaemonSpawnHooks.buildExtraEnvForChild', () => {
  it('does not force CLAUDE_CONFIG_DIR when no override is set', async () => {
    const homeDir = await createTempDir('happier-claude-spawnhooks-home-');
    tempDirs.add(homeDir);
    envScope.patch({
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: undefined,
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
    });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect(claudeDaemonSpawnHooks.buildExtraEnvForChild?.({} as any)).toEqual({});
  });

  it('publishes an explicit CLAUDE_CONFIG_DIR override when set', async () => {
    envScope.patch({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
    });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect(claudeDaemonSpawnHooks.buildExtraEnvForChild?.({} as any)).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
    });
  });

  it('preserves only Claude\'s exact external sandbox assertion for the session runner', async () => {
    envScope.patch({
      CLAUDE_CONFIG_DIR: undefined,
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
      IS_SANDBOX: '1',
    });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect(claudeDaemonSpawnHooks.buildExtraEnvForChild?.({} as any)).toEqual({
      IS_SANDBOX: '1',
    });

    envScope.patch({ IS_SANDBOX: '0' });
    expect(claudeDaemonSpawnHooks.buildExtraEnvForChild?.({} as any)).toEqual({});
  });
});

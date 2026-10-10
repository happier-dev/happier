import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'smol-toml';

import { codexStateSharingDescriptor } from '../../../../../../packages/plugins/codex/src/agent/auth/services/state/sharing/descriptor';
import { claudeAuthStateSharingDescriptor } from '../../../../../../packages/plugins/claude/src/agent/auth/services/stateSharing';

import {
  applyConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceNativeHomeRoot,
} from './applyConnectedServiceStateSharingDescriptor';

function createDescriptor(params: Readonly<{
  configEntries?: ConnectedServiceStateSharingDescriptor['config']['entries'];
  stateEntries?: ConnectedServiceStateSharingDescriptor['state']['entries'];
}> = {}): ConnectedServiceStateSharingDescriptor {
  return {
    providerId: 'codex',
    providerSupportStatus: 'supported',
    config: {
      supported: true,
      modes: ['linked', 'copied', 'isolated'],
      entries: params.configEntries ?? [],
    },
    state: {
      supported: true,
      modes: ['shared', 'isolated'],
      entries: params.stateEntries ?? [],
      symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
    },
    authIsolation: {
      mode: 'materialized_home',
      secretEntries: ['auth.json'],
    },
  };
}

describe('applyConnectedServiceStateSharingDescriptor', () => {
  it.each(['shared', 'isolated'] as const)('prepares declared missing history directories only for effective shared state: %s', async (stateMode) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-first-shared-state-'));
    const sourceRoot = join(root, 'native');
    const targetRoot = join(root, 'private');
    const entries = [{ path: 'antigravity-acp/conversations', mode: 'linked', createIfMissing: 'directory' }] as const;
    try {
      await applyConnectedServiceStateSharingDescriptor({
        descriptor: { ...createDescriptor({ stateEntries: entries }), state: {
          supported: true, modes: ['shared', 'isolated'], entries, symlinkUnavailableDegradePolicy: 'block_continuity',
        } },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: stateMode, effectiveStateMode: stateMode, cwd: root,
      });
      if (stateMode === 'shared') {
        expect(await realpath(join(targetRoot, entries[0].path))).toBe(join(sourceRoot, entries[0].path));
        expect((await lstat(join(targetRoot, 'antigravity-acp'))).isSymbolicLink()).toBe(false);
      } else {
        await expect(lstat(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['linked', 'copied', 'isolated'] as const)('shares native Agent configuration and rebases hook decisions in %s mode', async (configMode) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-config-'));
    const sourceRoot = join(root, 'native');
    const promotedRoot = join(root, 'promoted');
    const stageRoot = join(root, 'stage');
    const nativeKey = `${join(sourceRoot, 'hooks.json')}:stop:0:0`;
    const inlineKey = `${join(sourceRoot, 'config.toml')}:session_start:0:0`;
    const profileKey = `${join(promotedRoot, 'hooks.json')}:stop:0:0`;
    const profileInlineKey = `${join(promotedRoot, 'config.toml')}:session_start:0:0`;
    const unrelatedKey = `${join(sourceRoot, 'hooks.json.other')}:stop:0:0`;
    const nativeDecision = { enabled: true, trusted_hash: 'sha256:unchanged' };
    try {
      await mkdir(join(sourceRoot, 'plugins'), { recursive: true });
      await writeFile(join(sourceRoot, 'plugins', 'plugin.json'), '{"name":"native-plugin"}');
      await writeFile(join(sourceRoot, 'CLAUDE.md'), 'Native instructions');
      await writeFile(join(sourceRoot, 'hooks.json'), '{"hooks":{"Stop":[]}}');
      await writeFile(join(sourceRoot, 'config.toml'), stringify({ hooks: { state: {
        [nativeKey]: nativeDecision, [inlineKey]: nativeDecision,
        [unrelatedKey]: nativeDecision, 'plugin:example:stop:0:0': nativeDecision,
      } } }));
      const input = {
        descriptor: codexStateSharingDescriptor,
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: promotedRoot, targetMaterializedEnv: {} },
        configMode, requestedStateMode: 'isolated' as const, effectiveStateMode: 'isolated' as const, cwd: root,
      };
      await applyConnectedServiceStateSharingDescriptor(input);
      if (configMode === 'isolated') {
        await expect(lstat(join(promotedRoot, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(promotedRoot, 'plugins'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const first = parse(await readFile(join(promotedRoot, 'config.toml'), 'utf8'));
        expect.soft(first.hooks).toEqual({ state: {
          [profileKey]: nativeDecision, [profileInlineKey]: nativeDecision,
          [unrelatedKey]: nativeDecision, 'plugin:example:stop:0:0': nativeDecision,
        } });
        await expect.soft(readFile(join(promotedRoot, 'plugins', 'plugin.json'), 'utf8')).resolves.toContain('native-plugin');
        await expect.soft(lstat(join(promotedRoot, 'plugins')).then(stat => stat.isSymbolicLink())).resolves.toBe(configMode === 'linked');
        const profileDecision = { enabled: false, trusted_hash: 'sha256:profile-review' };
        await writeFile(join(promotedRoot, 'config.toml'), stringify({ hooks: { state: {
          [profileKey]: profileDecision, [profileInlineKey]: profileDecision,
        } } }));
        await applyConnectedServiceStateSharingDescriptor({ ...input,
          previousMaterializedRoot: promotedRoot,
          target: { targetMaterializedRoot: stageRoot, targetMaterializedEnv: {} },
        });
        const staged = parse(await readFile(join(stageRoot, 'config.toml'), 'utf8'));
        expect.soft(staged.hooks).toEqual({ state: {
          [profileKey]: profileDecision, [profileInlineKey]: profileDecision,
          [unrelatedKey]: nativeDecision, 'plugin:example:stop:0:0': nativeDecision,
        } });
      }
      const claudeRoot = join(root, 'claude');
      await applyConnectedServiceStateSharingDescriptor({ ...input, descriptor: claudeAuthStateSharingDescriptor,
        target: { targetMaterializedRoot: claudeRoot, targetMaterializedEnv: {} },
      });
      if (configMode === 'isolated') {
        await expect(lstat(join(claudeRoot, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(readFile(join(claudeRoot, 'CLAUDE.md'), 'utf8')).resolves.toBe('Native instructions');
        expect((await lstat(join(claudeRoot, 'CLAUDE.md'))).isSymbolicLink()).toBe(configMode === 'linked');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports malformed native TOML without exposing config content or replacing the promoted home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-invalid-profile-config-'));
    const sourceRoot = join(root, 'native');
    const previousMaterializedRoot = join(root, 'promoted');
    const targetRoot = join(root, 'stage');
    try {
      await Promise.all([sourceRoot, previousMaterializedRoot].map((home) => mkdir(home, { recursive: true })));
      await writeFile(join(sourceRoot, 'config.toml'), 'model = "native"\n');
      await writeFile(join(previousMaterializedRoot, 'config.toml'), 'model = "profile"\n');
      await writeFile(join(previousMaterializedRoot, 'hooks.json'), '{"hooks":{"Stop":[]}}\n');
      const invalidPath = join(sourceRoot, 'config.toml');
      await writeFile(invalidPath, 'fixture_secret = "synthetic-sensitive-config"\n[broken\n');
      const priorConfig = await readFile(join(previousMaterializedRoot, 'config.toml'), 'utf8');
      const error = await applyConnectedServiceStateSharingDescriptor({
        descriptor: {
          ...createDescriptor({ configEntries: [{ path: 'config.toml', mode: 'force_copied' }, { path: 'hooks.json', mode: 'force_copied' }] }),
          transforms: [{ entry: 'config.toml', kind: 'rewrite_toml', spec: {
            setStringValues: { cli_auth_credentials_store: 'file' },
            preserveTableEntries: [{ tablePath: ['hooks', 'state'], keyPrefixEntry: 'hooks.json', keyPrefixSuffix: ':' }],
          } }],
        },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        previousMaterializedRoot,
        configMode: 'linked', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      }).then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      const reported = inspect(error, { depth: 5 });
      expect(reported).toContain(invalidPath);
      expect(reported).toMatch(/line \d+, column \d+/);
      expect(reported).toContain('TomlError');
      expect(reported).not.toContain('synthetic-sensitive-config');
      await expect(readFile(join(previousMaterializedRoot, 'config.toml'), 'utf8')).resolves.toBe(priorConfig);
      await expect(readFile(join(previousMaterializedRoot, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([true, false])('rebuilds malformed profile TOML with a safe diagnostic (native config: %s)', async (hasNativeConfig) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-profile-config-recovery-'));
    const sourceRoot = join(root, 'native');
    const previousMaterializedRoot = join(root, 'promoted');
    const targetRoot = join(root, 'stage');
    try {
      await Promise.all([sourceRoot, previousMaterializedRoot].map(home => mkdir(home, { recursive: true })));
      if (hasNativeConfig) await writeFile(join(sourceRoot, 'config.toml'), 'model = "native"\n');
      await writeFile(join(previousMaterializedRoot, 'config.toml'), 'fixture_secret = "synthetic-sensitive-config"\n[broken\n');
      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: {
          ...createDescriptor({ configEntries: [{ path: 'config.toml', mode: 'force_copied' }, { path: 'hooks.json', mode: 'force_copied' }] }),
          transforms: [{ entry: 'config.toml', kind: 'rewrite_toml', spec: {
            setStringValues: { cli_auth_credentials_store: 'file' },
            preserveTableEntries: [{ tablePath: ['hooks', 'state'], keyPrefixEntry: 'hooks.json', keyPrefixSuffix: ':' }],
          } }],
        },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        previousMaterializedRoot,
        configMode: 'copied', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      });
      const config = await readFile(join(targetRoot, 'config.toml'), 'utf8');
      if (hasNativeConfig) expect(config).toContain('model = "native"');
      else expect(config).not.toContain('model =');
      expect(config).toContain('cli_auth_credentials_store = "file"');
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'profile_config_invalid', severity: 'warning' }));
      expect(inspect(result)).not.toContain('synthetic-sensitive-config');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { configMode: 'linked', sourceConfig: true },
    { configMode: 'copied', sourceConfig: true },
    { configMode: 'linked', sourceConfig: false },
  ] as const)('keeps copied hooks and profile preferences in staged $configMode config (source config: $sourceConfig)', async ({ configMode, sourceConfig }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-profile-hooks-'));
    const sourceRoot = join(root, 'native');
    const previousMaterializedRoot = join(root, 'promoted');
    const targetRoot = join(root, 'stage');
    try {
      await Promise.all([sourceRoot, previousMaterializedRoot, targetRoot].map((home) => mkdir(home, { recursive: true })));
      const sourceHooks = join(sourceRoot, 'hooks.json');
      const targetHooks = join(targetRoot, 'hooks.json');
      await writeFile(sourceHooks, '{"hooks":{"Stop":[]}}\n');
      await symlink(sourceHooks, targetHooks, 'file');
      const hookId = `${join(previousMaterializedRoot, 'hooks.json')}:stop:0:0`;
      const unrelatedId = `${join(sourceRoot, 'hooks.json')}:stop:0:0`;
      if (sourceConfig) await writeFile(join(sourceRoot, 'config.toml'), 'model = "source"\nmodel_context_window = 9223372036854775807\n');
      await writeFile(join(previousMaterializedRoot, 'config.toml'),
        `model = 'profile'\n[features]\nexperimental = true\n[hooks.state.'${hookId}'] # native preferences\nenabled = false\ntrusted_hash = 'sha256:reviewed'\n` +
        `[hooks.state.'${hookId.replace(':stop:0:0', ':session_start:0:0')}']\nenabled = false\n` +
        `[hooks.state.'${unrelatedId}']\ntrusted_hash = 'sha256:foreign'\n`);
      const input = {
        descriptor: {
          ...createDescriptor({ configEntries: [
            { path: 'config.toml', mode: 'force_copied' }, { path: 'hooks.json', mode: 'force_copied' },
          ] }),
          transforms: [{ entry: 'config.toml', kind: 'rewrite_toml' as const, spec: {
            setStringValues: { cli_auth_credentials_store: 'file' },
            preserveTableEntries: [{ tablePath: ['hooks', 'state'], keyPrefixEntry: 'hooks.json', keyPrefixSuffix: ':' }],
          } }],
        },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        previousMaterializedRoot,
        configMode, requestedStateMode: 'isolated' as const, effectiveStateMode: 'isolated' as const, cwd: root,
      };
      const result = await applyConnectedServiceStateSharingDescriptor(input);
      expect((await lstat(targetHooks)).isSymbolicLink()).toBe(false);
      await writeFile(sourceHooks, '{"hooks":{"SessionStart":[]}}\n');
      await expect(readFile(targetHooks, 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');
      const config = await readFile(join(targetRoot, 'config.toml'), 'utf8');
      expect(config.match(/enabled = false/g)).toHaveLength(2);
      if (sourceConfig) expect(config).toContain('9223372036854775807');
      expect(config).toContain('sha256:reviewed');
      expect(config).toContain(hookId);
      expect(config).not.toContain(unrelatedId);
      if (sourceConfig) expect(config).toContain('model = "source"');
      else {
        expect(config).not.toContain('model =');
        expect(config).not.toContain('experimental');
      }
      expect(config).toContain('cli_auth_credentials_store = "file"');
      expect(result.manifest.configEntries).toContain('config.toml');
      expect((await lstat(join(targetRoot, 'config.toml'))).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('resolves native Agent homes from the declared environment key or its home-relative default', () => {
    expect(resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CODEX_HOME',
        defaultRelativePath: '.codex',
      },
      sourceEnvironment: { CODEX_HOME: '/provider/codex-home' },
      homeDir: '/users/example',
    })).toBe('/provider/codex-home');
    expect(resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CODEX_HOME',
        defaultRelativePath: '.codex',
      },
      sourceEnvironment: {},
      homeDir: '/users/example',
    })).toBe('/users/example/.codex');
  });

  it('rejects relative environment overrides and defaults that escape the host home', () => {
    expect(() => resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CLAUDE_CONFIG_DIR',
        defaultRelativePath: '.claude',
      },
      sourceEnvironment: { CLAUDE_CONFIG_DIR: '../ambient-claude' },
      homeDir: '/users/example',
    })).toThrow('connected_service_native_home_environment_must_be_absolute');
    expect(() => resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CLAUDE_CONFIG_DIR',
        defaultRelativePath: '../ambient-claude',
      },
      sourceEnvironment: {},
      homeDir: '/users/example',
    })).toThrow('connected_service_native_home_default_must_be_home_relative');
  });

  it('materializes descriptor entries and emits extended manifest metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'config.toml'), 'model = "gpt-5.3-codex"\n');
      await writeFile(join(sourceRoot, 'session_index.jsonl'), '{"id":"source"}\n');

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'linked_or_copied' }],
          stateEntries: [{ path: 'session_index.jsonl', mode: 'linked' }],
        }),
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        cwd: root,
      });

      await expect(readFile(join(targetRoot, 'config.toml'), 'utf8')).resolves.toBe('model = "gpt-5.3-codex"\n');
      await expect(readFile(join(targetRoot, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      expect(result.envOverrides).toEqual({});
      expect(result.diagnostics).toEqual([]);
      expect(result.manifest).toMatchObject({
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        configEntries: ['config.toml'],
        stateEntries: ['session_index.jsonl'],
        sessionFileMappings: [],
        diagnostics: [],
      });
      expect(result.manifest.lastSyncAtMs).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails fast in dev builds when native source root is nested under target root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-invariant-'));
    const targetRoot = join(root, 'target');
    const nestedSource = join(targetRoot, 'native-source');
    try {
      await mkdir(nestedSource, { recursive: true });
      await writeFile(join(nestedSource, 'config.toml'), 'model = "nested"\n');

      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'copied' }],
        }),
        nativeSourceContext: {
          sourceRoot: nestedSource,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      })).rejects.toThrow('nativeSourceContext.sourceRoot must not be nested under target.targetMaterializedRoot');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows migration reads under target root only through explicit existing-materialized allowlists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-migration-'));
    const targetRoot = join(root, 'target');
    const legacySource = join(targetRoot, 'legacy-source');
    try {
      await mkdir(legacySource, { recursive: true });
      await writeFile(join(legacySource, 'config.toml'), 'model = "legacy"\n');

      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'copied' }],
        }),
        nativeSourceContext: {
          sourceRoot: legacySource,
          sourceEnv: {},
        },
        existingMaterializedStateContext: {
          previousMaterializedRoot: targetRoot,
          allowedRelativePaths: ['legacy-source'],
          expiresAfterRelease: '2026.06',
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      })).resolves.toMatchObject({
        manifest: expect.objectContaining({
          configEntries: ['config.toml'],
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies declarative rewrite_toml transforms for force_copied descriptor entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-transform-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(
        join(sourceRoot, 'config.toml'),
        [
          'model = "gpt-5.3-codex"',
          'cli_auth_credentials_store = "keyring"',
          '',
          '[features]',
          'multi_agent = true',
          '',
        ].join('\n'),
      );

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: {
          ...createDescriptor({
            configEntries: [{ path: 'config.toml', mode: 'force_copied' }],
          }),
          transforms: [
            {
              entry: 'config.toml',
              kind: 'rewrite_toml',
              spec: {
                setStringValues: {
                  cli_auth_credentials_store: 'file',
                },
              },
            },
          ],
        },
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'linked',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      });

      expect(result.manifest.configEntries).toEqual(['config.toml']);
      const transformed = await readFile(join(targetRoot, 'config.toml'), 'utf8');
      expect(transformed).toContain('cli_auth_credentials_store = "file"');
      expect(transformed).not.toContain('cli_auth_credentials_store = "keyring"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { describe, expect, it } from 'vitest';

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

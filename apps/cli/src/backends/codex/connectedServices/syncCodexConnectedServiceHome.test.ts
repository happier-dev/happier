import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCodexHomePair, exists, loadSyncCodexConnectedServiceHome, mockAllSymlinksFail, mockSymlinkFailureForTempLink, settings, waitFor } from './syncCodexConnectedServiceHome.testUtils';

describe('syncCodexConnectedServiceHome', () => {
  afterEach(async () => {
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('@/backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('preserves Codex-owned isolated state across repeated materialization', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      // Shared session state is the default now, so explicitly opt this Codex home
      // out via the isolated state mode to exercise the isolated-preservation path.
      const result = await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      expect(result.targetSqliteHome).toBe(destinationCodexHome);

      await mkdir(join(destinationCodexHome, 'sessions', '2026', '05', '20'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'sessions', '2026', '05', '20', 'rollout.jsonl'), '{"id":"local"}\n');
      await writeFile(join(destinationCodexHome, 'state_5.sqlite'), 'sqlite');
      await writeFile(join(destinationCodexHome, 'state_5.sqlite-wal'), 'wal');

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      await expect(readFile(join(destinationCodexHome, 'sessions', '2026', '05', '20', 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
      await expect(readFile(join(destinationCodexHome, 'state_5.sqlite'), 'utf8')).resolves.toBe('sqlite');
      await expect(readFile(join(destinationCodexHome, 'state_5.sqlite-wal'), 'utf8')).resolves.toBe('wal');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an explicitly separate SQLite home when the shared Codex home is already the destination', async () => {
    const { root, destinationCodexHome } = await createCodexHomePair();
    try {
      const sourceSqliteHome = join(root, 'native-sqlite');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      const result = await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: {
          CODEX_HOME: destinationCodexHome,
          CODEX_SQLITE_HOME: sourceSqliteHome,
        },
      });

      expect(result.targetSqliteHome).toBe(sourceSqliteHome);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports local isolated rollouts while leaving SQLite state to CODEX_SQLITE_HOME', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      await writeFile(join(sourceCodexHome, 'history.jsonl'), '{"text":"source prompt"}\n');
      await mkdir(join(sourceCodexHome, 'memories', 'rollout_summaries'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'memories', 'raw_memories.md'), '# Source memory\n');
      await writeFile(join(sourceCodexHome, 'logs_2.sqlite'), 'source logs');
      await mkdir(join(destinationCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'sessions', 'local-rollout.jsonl'), '{"id":"local"}\n');
      await writeFile(join(destinationCodexHome, 'state_5.sqlite'), 'local sqlite');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      await expect(readFile(join(destinationCodexHome, 'sessions', 'source-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      await expect(readFile(join(destinationCodexHome, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"source prompt"}\n');
      await expect(readFile(join(destinationCodexHome, 'memories', 'raw_memories.md'), 'utf8')).resolves.toBe('# Source memory\n');
      await expect(readFile(join(sourceCodexHome, 'logs_2.sqlite'), 'utf8')).resolves.toBe('source logs');
      await expect(readFile(join(sourceCodexHome, 'sessions', 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
      await expect(readFile(join(destinationCodexHome, 'sessions', 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
      const destinationEntries = await readdir(destinationCodexHome);
      const migratedSessionsEntry = destinationEntries.find((entry) => entry.startsWith('sessions.local-'));
      expect(migratedSessionsEntry).toBeDefined();
      await expect(readFile(join(destinationCodexHome, migratedSessionsEntry!, 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
      await expect(readFile(join(destinationCodexHome, 'state_5.sqlite'), 'utf8')).resolves.toBe('local sqlite');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes linked state when returning to isolated mode without deleting real state', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      await mkdir(destinationCodexHome, { recursive: true });
      await symlink(join(sourceCodexHome, 'sessions'), join(destinationCodexHome, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
      await mkdir(join(destinationCodexHome, 'archived_sessions'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'archived_sessions', 'local-rollout.jsonl'), '{"id":"local"}\n');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      await expect(exists(join(destinationCodexHome, 'sessions'))).resolves.toBe(false);
      await expect(readFile(join(destinationCodexHome, 'archived_sessions', 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('degrades shared state to isolated when required symlinks are unavailable', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      await mkdir(join(destinationCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'sessions', 'local-rollout.jsonl'), '{"id":"local"}\n');

      mockAllSymlinksFail();
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      const result = await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      expect(result).toMatchObject({
        providerId: 'codex',
        requestedStateMode: 'shared',
        effectiveStateMode: 'isolated',
        diagnostics: [
          {
            code: 'state_symlink_unavailable',
            providerId: 'codex',
            requestedStateMode: 'shared',
            effectiveStateMode: 'isolated',
            entryName: 'sessions',
            reason: 'symlink_unavailable',
          },
        ],
        targetSqliteHome: destinationCodexHome,
      });
      await expect(readFile(join(destinationCodexHome, 'sessions', 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors descriptor symlink policy when set to block continuity', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      await mkdir(join(destinationCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'sessions', 'local-rollout.jsonl'), '{"id":"local"}\n');

      mockAllSymlinksFail();
      vi.resetModules();
      vi.doMock('@/backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor', async () => {
        const actual = await vi.importActual<typeof import('./codexConnectedServiceStateSharingDescriptor')>(
          './codexConnectedServiceStateSharingDescriptor',
        );
        return {
          ...actual,
          codexConnectedServiceStateSharingDescriptor: {
            ...actual.codexConnectedServiceStateSharingDescriptor,
            state: {
              ...actual.codexConnectedServiceStateSharingDescriptor.state,
              symlinkUnavailableDegradePolicy: 'block_continuity',
            },
          },
        };
      });
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await expect(syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      })).rejects.toThrow(/Cannot enable shared Codex state/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares SQLite state through one CODEX_SQLITE_HOME while keeping rollouts under CODEX_HOME', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const sourceSqliteHome = join(root, 'source-sqlite-home');
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      await mkdir(sourceSqliteHome, { recursive: true });
      await writeFile(join(sourceSqliteHome, 'state_5.sqlite'), 'sqlite-home');
      await writeFile(join(sourceCodexHome, 'state_5.sqlite'), 'codex-home');
      await writeFile(join(sourceSqliteHome, 'logs_2.sqlite'), 'logs');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      const result = await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: {
          CODEX_HOME: sourceCodexHome,
          CODEX_SQLITE_HOME: sourceSqliteHome,
        },
      });

      expect(result.targetSqliteHome).toBe(sourceSqliteHome);
      await expect(readFile(join(destinationCodexHome, 'sessions', 'source-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      await expect(exists(join(destinationCodexHome, 'state_5.sqlite'))).resolves.toBe(false);
      await expect(exists(join(destinationCodexHome, 'logs_2.sqlite'))).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses a hard link for shared state metadata when file symlinks are unavailable', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await writeFile(join(sourceCodexHome, 'session_index.jsonl'), '{"id":"initial"}\n');

      mockSymlinkFailureForTempLink('session_index.jsonl.happier-link');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      const destinationIndexPath = join(destinationCodexHome, 'session_index.jsonl');
      expect((await lstat(destinationIndexPath)).isSymbolicLink()).toBe(false);
      await expect(readFile(destinationIndexPath, 'utf8')).resolves.toBe('{"id":"initial"}\n');
      await writeFile(join(sourceCodexHome, 'session_index.jsonl'), '{"id":"changed"}\n');
      await expect(readFile(destinationIndexPath, 'utf8')).resolves.toBe('{"id":"changed"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes temporary shared-state links when replacement fails', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');

      vi.resetModules();
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
            const [sourcePath] = args;
            if (String(sourcePath).includes('sessions.happier-link')) {
              const error = new Error('replace failed') as NodeJS.ErrnoException;
              error.code = 'EACCES';
              throw error;
            }
            return actual.rename(...args);
          }),
        };
      });
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await expect(syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      })).rejects.toThrow(/replace failed/);

      await expect(readdir(destinationCodexHome)).resolves.not.toContainEqual(expect.stringContaining('.happier-link-'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies mutable config and materializes only current Codex home config entries', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.3-codex"\n');
      await writeFile(join(sourceCodexHome, 'config.json'), '{"legacy":true}\n');
      await writeFile(join(sourceCodexHome, 'instructions.md'), 'legacy instructions\n');
      await writeFile(join(sourceCodexHome, 'environments.toml'), '[env.default]\n');
      await writeFile(join(sourceCodexHome, 'hooks.json'), '{"hooks":[]}\n');
      await mkdir(join(sourceCodexHome, 'rules'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'rules', 'default.rules'), 'prefix_rule(pattern=["git"], decision="allow")\n');
      await mkdir(join(sourceCodexHome, 'agents', 'reviewer'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'agents', 'reviewer', 'config.toml'), 'name = "reviewer"\n');
      await mkdir(join(sourceCodexHome, 'skills', '.system'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'skills', '.system', 'builtin.md'), 'built in\n');
      await mkdir(join(sourceCodexHome, 'skills', 'reviewer'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "changed-after-sync"\n');

      const copiedConfig = await readFile(join(destinationCodexHome, 'config.toml'), 'utf8');
      expect(copiedConfig).toContain('model = "gpt-5.3-codex"');
      expect(copiedConfig).toContain('cli_auth_credentials_store = "file"');
      await expect(readFile(join(destinationCodexHome, 'environments.toml'), 'utf8')).resolves.toBe('[env.default]\n');
      await expect(readFile(join(destinationCodexHome, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":[]}\n');
      await expect(readFile(join(destinationCodexHome, 'instructions.md'), 'utf8')).resolves.toBe('legacy instructions\n');
      await expect(readFile(join(destinationCodexHome, 'rules', 'default.rules'), 'utf8')).resolves.toBe('prefix_rule(pattern=["git"], decision="allow")\n');
      await expect(readFile(join(destinationCodexHome, 'agents', 'reviewer', 'config.toml'), 'utf8')).resolves.toBe('name = "reviewer"\n');
      await expect(readFile(join(destinationCodexHome, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).resolves.toBe('# Reviewer\n');
      await expect(readFile(join(destinationCodexHome, 'skills', '.system', 'builtin.md'), 'utf8')).resolves.toBe('built in\n');
      await expect(exists(join(destinationCodexHome, 'config.json'))).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves home-owned config when config sharing is isolated', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "source"\n');
      await mkdir(destinationCodexHome, { recursive: true });
      await writeFile(join(destinationCodexHome, 'config.toml'), 'model = "local"\n');
      await mkdir(join(destinationCodexHome, 'skills', 'local'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'skills', 'local', 'SKILL.md'), '# Local\n');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('isolated', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      await expect(readFile(join(destinationCodexHome, 'config.toml'), 'utf8')).resolves.toBe('model = "local"\n');
      await expect(readFile(join(destinationCodexHome, 'skills', 'local', 'SKILL.md'), 'utf8')).resolves.toBe('# Local\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes only manifest-managed config when config sharing is isolated after being enabled', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "source"\n');
      await mkdir(join(sourceCodexHome, 'skills', 'source'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'skills', 'source', 'SKILL.md'), '# Source\n');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('copied', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await mkdir(join(destinationCodexHome, 'skills', 'local'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'skills', 'local', 'SKILL.md'), '# Local\n');

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('isolated', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      await expect(exists(join(destinationCodexHome, 'config.toml'))).resolves.toBe(false);
      await expect(exists(join(destinationCodexHome, 'skills', 'source'))).resolves.toBe(false);
      await expect(readFile(join(destinationCodexHome, 'skills', 'local', 'SKILL.md'), 'utf8')).resolves.toBe('# Local\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forces copied config.toml to use file-backed Codex CLI auth storage', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await writeFile(
        join(sourceCodexHome, 'config.toml'),
        [
          'model = "gpt-5.3-codex"',
          'cli_auth_credentials_store = "keyring"',
          '',
          '[features]',
          'multi_agent = true',
          '',
        ].join('\n'),
      );
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      const copiedConfig = await readFile(join(destinationCodexHome, 'config.toml'), 'utf8');
      expect(copiedConfig).toContain('cli_auth_credentials_store = "file"');
      expect(copiedConfig).not.toContain('cli_auth_credentials_store = "keyring"');
      expect(copiedConfig.indexOf('cli_auth_credentials_store = "file"')).toBeLessThan(copiedConfig.indexOf('[features]'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips dangling source config symlinks instead of failing spawn', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await symlink(join(root, 'missing-prompts'), join(sourceCodexHome, 'prompts'), process.platform === 'win32' ? 'junction' : 'dir');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      await expect(exists(join(destinationCodexHome, 'prompts'))).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent syncs for the same destination Codex home', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      const symlinkCalls: string[] = [];
      let releaseFirstSymlink!: () => void;
      const firstSymlinkCanFinish = new Promise<void>((resolve) => {
        releaseFirstSymlink = resolve;
      });

      vi.resetModules();
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          symlink: vi.fn(async (...args: Parameters<typeof actual.symlink>) => {
            const [, destinationPath] = args;
            if (String(destinationPath).includes('sessions.happier-link')) {
              symlinkCalls.push(String(destinationPath));
              if (symlinkCalls.length === 1) {
                await firstSymlinkCanFinish;
              }
            }
            return actual.symlink(...args);
          }),
        };
      });
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      const firstSync = syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await waitFor(() => symlinkCalls.length === 1);
      const secondSync = syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      let overlapped = false;
      try {
        await waitFor(() => symlinkCalls.length > 1);
        overlapped = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Timed out')) throw error;
      }

      expect(overlapped).toBe(false);
      releaseFirstSymlink();
      await Promise.all([firstSync, secondSync]);
      expect(symlinkCalls).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes the canonical manifest shape and removes the legacy Codex manifest file', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.3-codex"\n');
      await mkdir(destinationCodexHome, { recursive: true });
      await writeFile(
        join(destinationCodexHome, '.happier-codex-home-sharing.json'),
        JSON.stringify({
          v: 1,
          configEntries: ['config.toml'],
          stateEntries: [],
        }),
      );
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('copied', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      const manifestRaw = await readFile(join(destinationCodexHome, '.happier-state-sharing.json'), 'utf8');
      expect(JSON.parse(manifestRaw)).toMatchObject({
        v: 1,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        configEntries: ['config.toml'],
        stateEntries: [],
        sessionFileMappings: [],
        diagnostics: [],
      });
      await expect(exists(join(destinationCodexHome, '.happier-codex-home-sharing.json'))).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

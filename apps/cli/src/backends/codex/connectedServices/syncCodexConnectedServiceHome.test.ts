import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parse } from 'smol-toml';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexHomePair, exists, loadSyncCodexConnectedServiceHome, settings, waitFor } from './syncCodexConnectedServiceHome.testUtils';

const fsBoundary = vi.hoisted(() => ({
  symlink: vi.fn<typeof import('node:fs/promises').symlink>(),
  rename: vi.fn<typeof import('node:fs/promises').rename>(),
}));

// Inject OS failures without reloading the real materializer and its dependency graph per case.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, symlink: fsBoundary.symlink, rename: fsBoundary.rename };
});

function mockAllSymlinksFail(): void {
  fsBoundary.symlink.mockImplementation(async () => {
    const error = new Error('symlink unavailable') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  });
}

async function mockSymlinkFailureForTempLink(destinationPathFragment: string): Promise<void> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsBoundary.symlink.mockImplementation(async (...args) => {
    if (String(args[1]).includes(destinationPathFragment)) {
      const error = new Error('file symlink unavailable') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return actual.symlink(...args);
  });
}

function isSessionsTemporaryLink(path: unknown): boolean {
  return basename(String(path)).startsWith('sessions.happier-link-');
}

describe('syncCodexConnectedServiceHome', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    fsBoundary.symlink.mockReset().mockImplementation(actual.symlink);
    fsBoundary.rename.mockReset().mockImplementation(actual.rename);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves Codex-owned isolated state across repeated materialization', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const previousCodexHome = join(root, 'previous-private-home');
      await mkdir(previousCodexHome, { recursive: true });
      await mkdir(destinationCodexHome, { recursive: true });
      await writeFile(join(previousCodexHome, 'history.jsonl'), '{"text":"previous private"}\n');
      await writeFile(join(previousCodexHome, 'session_index.jsonl'), '{"id":"session","updated_at":"2026-10-11"}\n');
      await writeFile(join(destinationCodexHome, 'history.jsonl'), '{"text":"existing private"}\n');
      await writeFile(join(destinationCodexHome, 'session_index.jsonl'), '{"id":"session","updated_at":"2026-10-10"}\n');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      // Shared session state is the default now, so explicitly opt this Codex home
      // out via the isolated state mode to exercise the isolated-preservation path.
      const result = await syncCodexConnectedServiceHome({
        destinationCodexHome,
        previousCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      expect(result.targetSqliteHome).toBe(destinationCodexHome);
      await expect(readFile(join(destinationCodexHome, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"existing private"}\n{"text":"previous private"}\n');
      await expect(readFile(join(destinationCodexHome, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"session","updated_at":"2026-10-10"}\n{"id":"session","updated_at":"2026-10-11"}\n');
      expect((await readdir(destinationCodexHome)).filter(entry => entry.startsWith('history.happier-import-') || entry.startsWith('session_index.happier-import-'))).toEqual([]);

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
      await expect(readFile(join(destinationCodexHome, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"existing private"}\n{"text":"previous private"}\n');
      await expect(readFile(join(previousCodexHome, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"previous private"}\n');
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

  it('cleans abandoned source-filesystem preflight directories while retaining unrelated native state', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const abandonedRoot = join(sourceCodexHome, '.happier-state-preflight-abandoned');
      await mkdir(join(abandonedRoot, 'sessions'), { recursive: true });
      await mkdir(join(sourceCodexHome, 'native-private'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'native-private', 'retained'), 'private');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();
      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('copied', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      expect((await readdir(sourceCodexHome)).filter((name) => name.startsWith('.happier-state-preflight-'))).toEqual([]);
      await expect(readFile(join(sourceCodexHome, 'native-private', 'retained'), 'utf8')).resolves.toBe('private');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves compressed rollouts and their exact thread mapping when sharing an isolated home', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    const threadId = '019f2339-9299-7e51-b192-9751a0a03586';
    const filename = `rollout-2026-11-06T00-00-00-${threadId}_019f2339-9299-7e51-b192-9751a0a03587.jsonl.zst`;
    const bytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    try {
      await mkdir(join(destinationCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'sessions', filename), bytes);
      const sync = await loadSyncCodexConnectedServiceHome();
      await sync({ destinationCodexHome, accountSettings: settings('isolated', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome } });
      await expect(readFile(join(sourceCodexHome, 'sessions', filename))).resolves.toEqual(bytes);
      const { readConnectedServiceStateSharingManifest } = await import('@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest');
      const manifest = await readConnectedServiceStateSharingManifest(destinationCodexHome);
      expect(manifest.sessionFileMappings).toEqual(expect.arrayContaining([
        expect.objectContaining({ vendorResumeId: threadId }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bootstraps a missing native sessions store before materializing shared Codex state', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('isolated', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      const nativeSessions = join(sourceCodexHome, 'sessions');
      const materializedSessions = join(destinationCodexHome, 'sessions');
      expect((await lstat(nativeSessions)).isDirectory()).toBe(true);
      expect((await lstat(materializedSessions)).isSymbolicLink()).toBe(true);

      await mkdir(join(materializedSessions, '2026', '08', '24'), { recursive: true });
      await writeFile(
        join(materializedSessions, '2026', '08', '24', 'rollout-new-session.jsonl'),
        '{"type":"session"}\n',
      );
      await expect(readFile(
        join(nativeSessions, '2026', '08', '24', 'rollout-new-session.jsonl'),
        'utf8',
      )).resolves.toBe('{"type":"session"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adopts isolated rollouts, memories and history without a previous home while retaining private SQLite state', async () => {
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
      await mkdir(join(destinationCodexHome, 'memories'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'memories', 'local-memory.md'), '# Local memory\n');
      await writeFile(join(destinationCodexHome, 'history.jsonl'), '{"text":"local prompt"}\n');
      await writeFile(join(destinationCodexHome, 'state_5.sqlite'), 'local sqlite');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });

      await expect(readFile(join(destinationCodexHome, 'sessions', 'source-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      expect([
        await readFile(join(sourceCodexHome, 'history.jsonl'), 'utf8'),
        await exists(join(sourceCodexHome, 'memories', 'local-memory.md')),
      ]).toEqual(['{"text":"source prompt"}\n{"text":"local prompt"}\n', true]);
      await expect(readFile(join(destinationCodexHome, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"source prompt"}\n{"text":"local prompt"}\n');
      await expect(readFile(join(destinationCodexHome, 'memories', 'raw_memories.md'), 'utf8')).resolves.toBe('# Source memory\n');
      await expect(readFile(join(destinationCodexHome, 'memories', 'local-memory.md'), 'utf8')).resolves.toBe('# Local memory\n');
      await expect(readFile(join(sourceCodexHome, 'logs_2.sqlite'), 'utf8')).resolves.toBe('source logs');
      await expect(readFile(join(sourceCodexHome, 'sessions', 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
      await expect(readFile(join(destinationCodexHome, 'sessions', 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
      const destinationEntries = await readdir(destinationCodexHome);
      const migratedSessionsEntry = destinationEntries.find((entry) => entry.startsWith('sessions.local-'));
      expect(migratedSessionsEntry).toBeDefined();
      await expect(readFile(join(destinationCodexHome, migratedSessionsEntry!, 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
      await expect(readFile(join(destinationCodexHome, 'state_5.sqlite'), 'utf8')).resolves.toBe('local sqlite');
      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await expect(readFile(join(sourceCodexHome, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"source prompt"}\n{"text":"local prompt"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('detaches shared state before private adoption while preserving config (self-source: %s)', async (selfSource) => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      await writeFile(join(sourceCodexHome, 'history.jsonl'), '{"text":"ambient shared"}\n');
      await writeFile(join(sourceCodexHome, 'session_index.jsonl'), '{"id":"ambient","updated_at":"2026-10-10"}\n');
      await writeFile(join(sourceCodexHome, 'AGENTS.md'), '# Shared config\n');
      const previousCodexHome = join(root, 'previous-shared-home');
      await mkdir(previousCodexHome, { recursive: true });
      await symlink(join(sourceCodexHome, 'history.jsonl'), join(previousCodexHome, 'history.jsonl'), 'file');
      await writeFile(join(previousCodexHome, 'session_index.jsonl'), '{"id":"private","updated_at":"2026-10-11"}\n');
      await mkdir(destinationCodexHome, { recursive: true });
      await symlink(join(sourceCodexHome, 'sessions'), join(destinationCodexHome, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(join(sourceCodexHome, 'history.jsonl'), join(destinationCodexHome, 'history.jsonl'), 'file');
      await symlink(join(sourceCodexHome, 'session_index.jsonl'), join(destinationCodexHome, 'session_index.jsonl'), 'file');
      await symlink(join(sourceCodexHome, 'AGENTS.md'), join(destinationCodexHome, 'AGENTS.md'), 'file');
      await mkdir(join(destinationCodexHome, 'archived_sessions'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'archived_sessions', 'local-rollout.jsonl'), '{"id":"local"}\n');
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        previousCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: selfSource ? destinationCodexHome : sourceCodexHome },
      });

      await expect(exists(join(destinationCodexHome, 'sessions'))).resolves.toBe(false);
      await expect(exists(join(destinationCodexHome, 'history.jsonl'))).resolves.toBe(false);
      expect([
        await readFile(join(sourceCodexHome, 'session_index.jsonl'), 'utf8'),
        await exists(join(destinationCodexHome, 'session_index.jsonl')),
      ]).toEqual(['{"id":"ambient","updated_at":"2026-10-10"}\n', true]);
      await expect(readFile(join(destinationCodexHome, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"private","updated_at":"2026-10-11"}\n');
      await expect(readFile(join(sourceCodexHome, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"ambient shared"}\n');
      expect((await lstat(join(destinationCodexHome, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
      await expect(readFile(join(destinationCodexHome, 'archived_sessions', 'local-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('degrades shared state to isolated when required symlinks are unavailable', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const previousCodexHome = join(root, 'previous-codex-home');
      await mkdir(join(destinationCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(destinationCodexHome, 'sessions', 'local-rollout.jsonl'), '{"id":"local"}\n');
      await mkdir(join(previousCodexHome, 'memories'), { recursive: true });
      await writeFile(join(previousCodexHome, 'history.jsonl'), '{"text":"previous prompt"}\n');
      await writeFile(join(previousCodexHome, 'memories', 'raw_memories.md'), '# Previous memory\n');

      mockAllSymlinksFail();
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      const result = await syncCodexConnectedServiceHome({
        destinationCodexHome,
        previousCodexHome,
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
      await expect(exists(join(sourceCodexHome, 'history.jsonl'))).resolves.toBe(false);
      await expect(exists(join(sourceCodexHome, 'memories', 'raw_memories.md'))).resolves.toBe(false);
      await expect(readdir(sourceCodexHome)).resolves.not.toContainEqual(expect.stringContaining('.happier-state-preflight-'));
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

      await mockSymlinkFailureForTempLink('session_index.jsonl.happier-link');
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

      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      fsBoundary.rename.mockImplementation(async (...args) => {
        if (isSessionsTemporaryLink(args[0])) {
          const error = new Error('replace failed') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return actual.rename(...args);
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

  it.each(['linked', 'copied'] as const)('copies mutable config and materializes current Codex home config entries in %s mode', async (configMode) => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.3-codex"\n');
      await writeFile(join(sourceCodexHome, 'config.json'), '{"legacy":true}\n');
      await writeFile(join(sourceCodexHome, 'instructions.md'), 'legacy instructions\n');
      await writeFile(join(sourceCodexHome, 'environments.toml'), '[env.default]\n');
      await writeFile(join(sourceCodexHome, 'hooks.json'), '{"hooks":[]}\n');
      await mkdir(join(sourceCodexHome, 'rules'), { recursive: true });
      await mkdir(join(sourceCodexHome, 'plugins', 'cache', 'example'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'plugins', 'cache', 'example', 'plugin.json'), '{"name":"example"}\n');
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
        accountSettings: settings(configMode, 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "changed-after-sync"\n');

      await expect(readFile(join(destinationCodexHome, 'plugins', 'cache', 'example', 'plugin.json'), 'utf8')).resolves.toBe('{"name":"example"}\n');
      expect((await lstat(join(destinationCodexHome, 'plugins'))).isSymbolicLink()).toBe(configMode === 'linked');

      const copiedConfig = await readFile(join(destinationCodexHome, 'config.toml'), 'utf8');
      expect(copiedConfig).toContain('model = "gpt-5.3-codex"');
      expect(copiedConfig).toContain('cli_auth_credentials_store = "file"');
      await expect(readFile(join(destinationCodexHome, 'environments.toml'), 'utf8')).resolves.toBe('[env.default]\n');
      await expect(readFile(join(destinationCodexHome, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":[]}\n');
      expect((await lstat(join(destinationCodexHome, 'hooks.json'))).isSymbolicLink()).toBe(false);
      await writeFile(join(sourceCodexHome, 'hooks.json'), '{"hooks":[{"changed":true}]}\n');
      await expect(readFile(join(destinationCodexHome, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":[]}\n');
      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      expect((await lstat(join(destinationCodexHome, 'hooks.json'))).isSymbolicLink()).toBe(false);
      await expect(readFile(join(destinationCodexHome, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":[{"changed":true}]}\n');
      await expect(readFile(join(destinationCodexHome, 'instructions.md'), 'utf8')).resolves.toBe('legacy instructions\n');
      await expect(readFile(join(destinationCodexHome, 'rules', 'default.rules'), 'utf8')).resolves.toBe('prefix_rule(pattern=["git"], decision="allow")\n');
      await expect(readFile(join(destinationCodexHome, 'agents', 'reviewer', 'config.toml'), 'utf8')).resolves.toBe('name = "reviewer"\n');
      await expect(readFile(join(destinationCodexHome, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).resolves.toBe('# Reviewer\n');
      await expect(readFile(join(destinationCodexHome, 'skills', '.system', 'builtin.md'), 'utf8')).resolves.toBe('built in\n');
      await expect(exists(join(destinationCodexHome, 'config.json'))).resolves.toBe(false);
      await syncCodexConnectedServiceHome({ destinationCodexHome, accountSettings: settings('isolated', 'isolated'), processEnv: { CODEX_HOME: sourceCodexHome } });
      await expect(exists(join(destinationCodexHome, 'plugins'))).resolves.toBe(false);
      await expect(readFile(join(sourceCodexHome, 'plugins', 'cache', 'example', 'plugin.json'), 'utf8')).resolves.toBe('{"name":"example"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replaces a previously linked hooks file with a copy in shared-state mode', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const sourceHooks = join(sourceCodexHome, 'hooks.json');
      const targetHooks = join(destinationCodexHome, 'hooks.json');
      await writeFile(sourceHooks, '{"hooks":{"Stop":[]}}\n');
      await mkdir(destinationCodexHome, { recursive: true });
      await symlink(sourceHooks, targetHooks, 'file');
      await writeFile(join(destinationCodexHome, '.happier-state-sharing.json'), JSON.stringify({
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        configEntries: ['hooks.json'],
        stateEntries: [],
      }));
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      expect((await lstat(targetHooks)).isSymbolicLink()).toBe(false);
      await expect(readFile(targetHooks, 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');

      await writeFile(sourceHooks, '{"hooks":{"SessionStart":[]}}\n');
      await expect(readFile(targetHooks, 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');
      await syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      expect((await lstat(targetHooks)).isSymbolicLink()).toBe(false);
      await expect(readFile(targetHooks, 'utf8')).resolves.toBe('{"hooks":{"SessionStart":[]}}\n');
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

  it.each([false, true])('preserves Codex hook trust after a repeated sync when source config exists: %s', async (sourceConfigExists) => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      if (sourceConfigExists) {
        await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "source"\n');
      }
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();
      const sync = () => syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await sync();
      const trustedHook = `${join(destinationCodexHome, 'hooks.json')}:Stop:0:0`;
      const trustSection = `[hooks.state.${JSON.stringify(trustedHook)}]\ntrusted_hash = "${'a'.repeat(64)}"\n`;
      await writeFile(join(destinationCodexHome, 'config.toml'),
        `model = "profile"\n[features]\nexperimental = true\n${trustSection}`);

      await sync();

      const config = await readFile(join(destinationCodexHome, 'config.toml'), 'utf8');
      expect(parse(config)).toMatchObject({ hooks: { state: { [trustedHook]: { trusted_hash: 'a'.repeat(64) } } } });
      expect(config.match(/trusted_hash/g)).toHaveLength(1);
      expect(parse(config).model).toBe(sourceConfigExists ? 'source' : undefined);
      expect(parse(config).features).toBeUndefined();
      expect(parse(config).cli_auth_credentials_store).toBe('file');
      const manifest = JSON.parse(await readFile(join(destinationCodexHome, '.happier-state-sharing.json'), 'utf8')) as { configEntries: string[] };
      expect(manifest.configEntries).toContain('config.toml');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['hooks.json', 'config.toml'])('rebases native %s hook decisions to the destination without importing another home approvals', async (entry) => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const sync = await loadSyncCodexConnectedServiceHome();
      const promotedHome = join(root, 'promoted');
      const sourceKey = `${join(sourceCodexHome, entry)}:stop:0:0`;
      const promotedKey = `${join(destinationCodexHome, entry)}:stop:0:0`;
      const unrelatedKey = `${join(sourceCodexHome, `${entry}.other`)}:stop:0:0`;
      const nativeConfig = [
        `[hooks.state.${JSON.stringify(sourceKey)}]`, 'trusted_hash = "sha256:reviewed-native"', 'enabled = false',
        `[hooks.state.${JSON.stringify(unrelatedKey)}]`, 'enabled = false',
        '[hooks.state."plugin:example:stop:0:0"]', 'trusted_hash = "sha256:plugin"', '',
      ].join('\n');
      await writeFile(join(sourceCodexHome, 'config.toml'), nativeConfig);
      const materialize = () => sync({ destinationCodexHome, previousCodexHome: promotedHome,
        accountSettings: settings('copied', 'isolated'), processEnv: { CODEX_HOME: sourceCodexHome } });
      await materialize();
      const readStates = async () => (parse(await readFile(join(destinationCodexHome, 'config.toml'), 'utf8')).hooks as { state: Record<string, unknown> }).state;
      expect(await readStates()).toEqual({
        [promotedKey]: { trusted_hash: 'sha256:reviewed-native', enabled: false },
        [unrelatedKey]: { enabled: false },
        'plugin:example:stop:0:0': { trusted_hash: 'sha256:plugin' },
      });
      await mkdir(promotedHome, { recursive: true });
      await writeFile(join(promotedHome, 'config.toml'), `[hooks.state.${JSON.stringify(`${join(promotedHome, entry)}:stop:0:0`)}]\ntrusted_hash = "sha256:unrelated-account"\nenabled = true\n`);
      await writeFile(join(destinationCodexHome, 'config.toml'), `[hooks.state.${JSON.stringify(promotedKey)}]\ntrusted_hash = "sha256:reviewed-profile"\nenabled = false\n`);
      await materialize();
      expect((await readStates())[promotedKey]).toEqual({ trusted_hash: 'sha256:reviewed-profile', enabled: false });
      expect(await readFile(join(sourceCodexHome, 'config.toml'), 'utf8')).toBe(nativeConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['linked', 'copied'] as const)('preserves destination hook trust and disabled state with a previous home in %s config', async (configMode) => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    try {
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();
      const previousCodexHome = join(root, 'promoted', 'codex-home');
      await mkdir(previousCodexHome, { recursive: true });
      const hookId = `${join(destinationCodexHome, 'hooks.json')}:stop:0:0`;
      const disabledOnlyId = `${join(destinationCodexHome, 'hooks.json')}:session_start:0:0`;
      const unrelatedId = `${join(sourceCodexHome, 'hooks.json')}:stop:0:0`;
      const hash = `sha256:${'a'.repeat(64)}`;
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "source"\n');
      await mkdir(destinationCodexHome, { recursive: true });
      await writeFile(join(destinationCodexHome, 'config.toml'), [
        `[hooks.state.'${hookId}'] # native user preferences`,
        `trusted_hash = '${hash}' # reviewed hook`,
        'enabled = false',
        `[hooks.state.'${disabledOnlyId}']`,
        'enabled = false',
        `[hooks.state.'${unrelatedId}']`,
        `trusted_hash = '${hash}'`,
        '',
      ].join('\n'));
      await syncCodexConnectedServiceHome({
        destinationCodexHome, previousCodexHome,
        accountSettings: settings(configMode, 'isolated'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      const config = parse(await readFile(join(destinationCodexHome, 'config.toml'), 'utf8'));
      expect(config).toMatchObject({
        model: 'source', cli_auth_credentials_store: 'file',
        hooks: { state: { [hookId]: { trusted_hash: hash, enabled: false }, [disabledOnlyId]: { enabled: false } } },
      });
      expect((config.hooks as { state: Record<string, unknown> }).state[unrelatedId]).toBeUndefined();
      expect((await lstat(join(destinationCodexHome, 'config.toml'))).mode & 0o777).toBe(0o600);
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
    let releaseFirstSymlink = () => {};
    try {
      await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
      await writeFile(join(sourceCodexHome, 'sessions', 'source-rollout.jsonl'), '{"id":"source"}\n');
      const symlinkCalls: string[] = [];
      const firstSymlinkCanFinish = new Promise<void>((resolve) => {
        releaseFirstSymlink = resolve;
      });

      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      fsBoundary.symlink.mockImplementation(async (...args) => {
        const [, destinationPath] = args;
        if (isSessionsTemporaryLink(destinationPath)) {
          symlinkCalls.push(String(destinationPath));
          if (symlinkCalls.length === 1) {
            await firstSymlinkCanFinish;
          }
        }
        return actual.symlink(...args);
      });
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      const firstSync = syncCodexConnectedServiceHome({
        destinationCodexHome,
        accountSettings: settings('linked', 'shared'),
        processEnv: { CODEX_HOME: sourceCodexHome },
      });
      await waitFor(() => symlinkCalls.length === 1, 10_000);
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
      expect((await lstat(join(destinationCodexHome, 'sessions'))).isSymbolicLink()).toBe(true);
      await expect(readFile(join(destinationCodexHome, 'sessions', 'source-rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
    } finally {
      releaseFirstSymlink();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reconciles fixed-name Codex state when different homes share one native source', async () => {
    const { root, sourceCodexHome, destinationCodexHome } = await createCodexHomePair();
    const secondDestinationCodexHome = join(root, 'materialized-codex-home-2');
    const firstPreviousCodexHome = join(root, 'previous-codex-home-1');
    const secondPreviousCodexHome = join(root, 'previous-codex-home-2');
    try {
      await mkdir(firstPreviousCodexHome, { recursive: true });
      await mkdir(secondPreviousCodexHome, { recursive: true });
      await writeFile(
        join(firstPreviousCodexHome, 'history.jsonl'),
        '{"session_id":"first","ts":1,"text":"first prompt"}\n',
      );
      await writeFile(
        join(secondPreviousCodexHome, 'history.jsonl'),
        '{"session_id":"second","ts":2,"text":"second prompt"}\n',
      );
      await writeFile(
        join(firstPreviousCodexHome, 'session_index.jsonl'),
        '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}\n',
      );
      await writeFile(
        join(secondPreviousCodexHome, 'session_index.jsonl'),
        '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}\n',
      );
      const syncCodexConnectedServiceHome = await loadSyncCodexConnectedServiceHome();

      await Promise.all([
        syncCodexConnectedServiceHome({
          destinationCodexHome,
          previousCodexHome: firstPreviousCodexHome,
          accountSettings: settings('linked', 'shared'),
          processEnv: { CODEX_HOME: sourceCodexHome },
        }),
        syncCodexConnectedServiceHome({
          destinationCodexHome: secondDestinationCodexHome,
          previousCodexHome: secondPreviousCodexHome,
          accountSettings: settings('linked', 'shared'),
          processEnv: { CODEX_HOME: sourceCodexHome },
        }),
      ]);

      const historyLines = (await readFile(join(sourceCodexHome, 'history.jsonl'), 'utf8')).trimEnd().split('\n');
      expect(historyLines).toHaveLength(2);
      expect(historyLines).toEqual(expect.arrayContaining([
        '{"session_id":"first","ts":1,"text":"first prompt"}',
        '{"session_id":"second","ts":2,"text":"second prompt"}',
      ]));
      const indexLines = (await readFile(join(sourceCodexHome, 'session_index.jsonl'), 'utf8')).trimEnd().split('\n');
      expect(indexLines).toHaveLength(2);
      expect(indexLines).toEqual(expect.arrayContaining([
        '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}',
        '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}',
      ]));
      await expect(readdir(sourceCodexHome)).resolves.not.toContainEqual(expect.stringContaining('.happier-import-'));
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

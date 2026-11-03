import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withCodexNativeStartupLock } from './nativeStartupLock.js';

const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: osBoundary.home }) };
});

beforeEach(async () => { osBoundary.home = await mkdtemp(join(tmpdir(), 'codex-startup-scope-')); });
afterEach(async () => { await rm(osBoundary.home, { recursive: true, force: true }); });

function startup(sqliteHome: string, versionOutput = 'codex-cli 0.162.1') {
  return { processEnv: { CODEX_HOME: join(osBoundary.home, 'auth-home'), CODEX_SQLITE_HOME: sqliteHome }, versionOutput, cwd: join(osBoundary.home, 'project') };
}

async function completeDatabase(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'state_5.sqlite'), 'SQLite format 3\0');
}

describe.skipIf(process.platform !== 'linux')('native SQLite startup admission', () => {
  beforeEach(async () => {
    await mkdir(join(osBoundary.home, '.codex'));
    await writeFile(join(osBoundary.home, '.codex', 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    await mkdir(join(osBoundary.home, 'project'));
  });
  it('preserves a live startup holder and recovers its abandoned lock after actual process exit', async () => {
    const lockPath = join(osBoundary.home, '.happier-codex-native-startup.lock');
    // Only the native holder is a subprocess. Both its publication and the
    // contender's admission use the real filesystem lock owner through the SDK.
    const holder = spawn(process.execPath, [
      '--conditions=happier-source',
      '--import', fileURLToPath(new URL('../../../../../../cli-common/registerSourceRuntime.mjs', import.meta.url)),
      '--input-type=module', '-e', `
        import { withExclusiveFileLock } from '@happier-dev/plugin-sdk/fs';
        await withExclusiveFileLock({ lockPath: process.argv[1], timeoutMs: Infinity }, async () => {
          process.stdin.once('data', () => process.exit(0));
          process.stdin.once('end', () => process.exit(0));
          process.stdout.write('held\\n');
          process.stdin.resume();
          await new Promise(() => {});
        });
      `, lockPath,
    ], { cwd: new URL('../../../..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
    holder.stderr.resume();
    const closed = new Promise<number | null>((resolve, reject) => {
      holder.once('close', resolve);
      holder.once('error', reject);
    });
    const lines = createInterface({ input: holder.stdout });
    const published = new Promise<void>((resolve, reject) => {
      lines.once('line', () => resolve());
      void closed.then(() => reject(new Error('Startup holder exited before publication')), reject);
    });
    const controller = new AbortController();
    let initialized = false;
    let waiting: Promise<unknown> | undefined;
    try {
      await published;
      const owner = await readFile(lockPath, 'utf8');
      expect(JSON.parse(owner)).toMatchObject({ pid: holder.pid });
      let observedWait!: () => void;
      const contention = new Promise<void>(resolve => { observedWait = resolve; });
      waiting = withCodexNativeStartupLock(async () => { initialized = true; }, controller.signal, {
        debug: () => observedWait(),
      });
      await contention;
      expect(initialized).toBe(false);
      expect(await readFile(lockPath, 'utf8')).toBe(owner);
      holder.stdin.end('exit');
      expect(await closed).toBe(0);
      await waiting;
      expect(initialized).toBe(true);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      holder.stdin.end();
      await waiting?.catch(() => undefined);
      await closed;
      lines.close();
    }
  });

  it('serializes fresh roots on the predecessor seam, including a second start at the same root', async () => {
    const rootA = join(osBoundary.home, 'sqlite-a');
    const rootB = join(osBoundary.home, 'sqlite-b');
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered: string[] = [];
    const debug = vi.fn();
    const start = (root: string, id: string) => withCodexNativeStartupLock(async () => {
      entered.push(id);
      await held;
      await completeDatabase(root);
    }, undefined, { debug }, startup(root));
    const first = start(rootA, 'a');
    const all: Promise<unknown>[] = [first];
    try {
      await vi.waitFor(() => expect(entered).toEqual(['a']));
      all.push(start(rootA, 'a2'), start(rootB, 'b'));
      await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(2));
      expect(entered).toEqual(['a']);
    } finally { release(); await Promise.all(all); }
    expect(entered[0]).toBe('a');
    expect(entered.slice(1).sort()).toEqual(['a2', 'b']);
  });

  it.each(['git-directory', 'git-file', 'no-marker', 'empty-git-directory'] as const)('does not queue warm same-version starts below an unrelated ancestor config (%s), but serializes a version change', async marker => {
    const cwd = join(osBoundary.home, 'project');
    if (marker === 'git-file') await writeFile(join(cwd, '.git'), 'gitdir: /fixture/worktree\n');
    if (marker === 'git-directory' || marker === 'empty-git-directory') {
      await mkdir(join(cwd, '.git'));
      if (marker === 'git-directory') await writeFile(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    const root = join(osBoundary.home, 'sqlite');
    await withCodexNativeStartupLock(async () => completeDatabase(root), undefined, undefined, startup(root));
    const bothEntered: string[] = [];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const warm = [1, 2].map(id => withCodexNativeStartupLock(async () => {
      bothEntered.push(`warm${id}`); await held;
    }, undefined, undefined, startup(root)));
    try { await vi.waitFor(() => expect(bothEntered).toHaveLength(2)); }
    finally { release(); await Promise.all(warm); }
    release = () => {};
    const migrationHeld = new Promise<void>(resolve => { release = resolve; });
    const debug = vi.fn();
    const migrating = withCodexNativeStartupLock(async () => {
      bothEntered.push('migration'); await migrationHeld;
    }, undefined, { debug }, startup(root, 'codex-cli 0.163.0'));
    let second: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(bothEntered).toContain('migration'));
      second = withCodexNativeStartupLock(async () => { bothEntered.push('next'); }, undefined, { debug }, startup(root, 'codex-cli 0.163.0'));
      await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(1));
      expect(bothEntered).not.toContain('next');
    } finally { release(); await migrating; await second; }
    expect(bothEntered).toContain('next');
  });

  it('pins the launch to the same canonical SQLite root and does not mark failed initialization warm', async () => {
    const root = join(osBoundary.home, 'sqlite');
    await mkdir(root);
    const alias = join(osBoundary.home, 'sqlite-alias');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const debug = vi.fn();
    let launchOverrides: readonly string[] | undefined;
    await expect(withCodexNativeStartupLock(async overrides => {
      launchOverrides = overrides;
      await completeDatabase(root);
      throw new Error('initialize failed');
    }, undefined, { debug }, { ...startup(alias), configOverrides: ['model="kept"'] })).rejects.toThrow('initialize failed');
    expect(launchOverrides).toEqual(['model="kept"', `sqlite_home=${JSON.stringify(root)}`]);
    await expect(readFile(join(root, '.happier-codex-native-startup.version'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains OS-user admission without a root marker when native managed auth cannot be resolved before launch', async () => {
    const root = join(osBoundary.home, 'sqlite');
    const configuration = startup(root);
    await mkdir(configuration.processEnv.CODEX_HOME, { recursive: true });
    await writeFile(join(configuration.processEnv.CODEX_HOME, 'auth.json'), '{}');
    await withCodexNativeStartupLock(async overrides => {
      expect(overrides).toEqual([`sqlite_home=${JSON.stringify(root)}`]);
      const owner = JSON.parse(await readFile(join(osBoundary.home, '.happier-codex-native-startup.lock'), 'utf8'));
      expect(owner.pid).toBe(process.pid);
    }, undefined, undefined, configuration);
    await expect(readFile(join(root, '.happier-codex-native-startup.version'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['cwd', 'project-root', 'custom-markers'] as const)('retains predecessor admission for a potentially effective config (%s)', async location => {
    const root = join(osBoundary.home, 'sqlite');
    const project = join(osBoundary.home, 'project');
    const cwd = join(project, 'nested');
    await mkdir(cwd);
    await mkdir(join(project, '.git'));
    await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    if (location !== 'custom-markers') {
      const configDir = join(location === 'cwd' ? cwd : project, '.codex');
      await mkdir(configDir);
      await writeFile(join(configDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    }
    const configuration = { ...startup(root), cwd,
      ...(location === 'custom-markers' ? { configOverrides: ['project_root_markers=[".custom-root"]'] } : {}),
    };
    await withCodexNativeStartupLock(async () => {
      const owner = JSON.parse(await readFile(join(osBoundary.home, '.happier-codex-native-startup.lock'), 'utf8'));
      expect(owner.pid).toBe(process.pid);
      await completeDatabase(root);
    }, undefined, undefined, configuration);
    await expect(readFile(join(root, '.happier-codex-native-startup.version'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('excludes a fresh resolved-root start while unresolved native initialization holds the global fallback', async () => {
    const root = join(osBoundary.home, 'shared-sqlite');
    const unknownHome = join(osBoundary.home, 'cloud-home');
    await mkdir(unknownHome);
    await writeFile(join(unknownHome, 'auth.json'), '{}');
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let unknownEntered = false;
    let knownEntered = false;
    const debug = vi.fn();
    const unknown = withCodexNativeStartupLock(async () => { unknownEntered = true; await held; }, undefined, { debug }, {
      ...startup(root), processEnv: { CODEX_HOME: unknownHome, CODEX_SQLITE_HOME: root },
    });
    let known: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(unknownEntered).toBe(true));
      known = withCodexNativeStartupLock(async () => { knownEntered = true; }, undefined, { debug }, startup(root));
      await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(1));
      expect(knownEntered).toBe(false);
    } finally { release(); await unknown; await known; }
  });

  it.skipIf(!process.env.HAPPIER_CODEX_NATIVE_TEST_BIN)('initializes two fresh native homes safely, then starts both against their warm shared database', async () => {
    const root = join(osBoundary.home, 'real-sqlite');
    const debug = vi.fn();
    const start = async (name: string, beforeReady?: () => Promise<void>) => {
      const home = join(osBoundary.home, name);
      await mkdir(home, { recursive: true });
      const configuration = { ...startup(root), processEnv: {
        PATH: process.env.PATH, HOME: osBoundary.home, CODEX_HOME: home, CODEX_SQLITE_HOME: root,
      } };
      return await withCodexNativeStartupLock(async overrides => {
        await beforeReady?.();
        const child = spawn(process.env.HAPPIER_CODEX_NATIVE_TEST_BIN!, ['app-server', ...overrides.flatMap(value => ['-c', value])], {
          cwd: configuration.cwd, env: configuration.processEnv, stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stderr.resume();
        const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
        const lines = createInterface({ input: child.stdout });
        try {
          const ready = new Promise<void>((resolve, reject) => {
            lines.on('line', line => {
              let message: { id?: unknown; result?: unknown; error?: unknown };
              try { message = JSON.parse(line); } catch { return; }
              if (message.id !== 1) return;
              if (message.error) reject(new Error('Native initialize rejected'));
              else resolve();
            });
            void closed.then(() => reject(new Error('Native exited before initialize')), reject);
          });
          child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {
            clientInfo: { name: 'happier_startup_probe', version: '0.1' }, capabilities: { experimentalApi: true },
          } })}\n`);
          await ready;
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        } finally {
          child.stdin.end();
          expect(await closed).toBe(0);
          lines.close();
        }
      }, undefined, { debug }, configuration);
    };
    await Promise.all([start('fresh-a'), start('fresh-b')]);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, '.happier-codex-native-startup.version'), 'utf8')).toBe('0.162.1\n');
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    const wait = async () => { entered++; await hold; };
    const warm = Promise.allSettled([start('warm-a', wait), start('warm-b', wait)]);
    try { await vi.waitFor(() => expect(entered).toBe(2)); }
    finally { release(); expect((await warm).every(result => result.status === 'fulfilled')).toBe(true); }
    expect(debug).toHaveBeenCalledTimes(1);
  }, 60_000);
});

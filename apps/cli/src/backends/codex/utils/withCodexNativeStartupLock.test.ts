import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ homedir: '', infoFile: vi.fn() }));

// OS home selection and the file-log sink are the only mocked boundaries.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: state.homedir }) };
});
vi.mock('@/ui/logger', () => ({ logger: { infoFile: state.infoFile } }));

import { withCodexNativeStartupLock } from './withCodexNativeStartupLock';

beforeEach(async () => {
  state.homedir = await mkdtemp(join(tmpdir(), 'happier-codex-startup-wait-'));
  state.infoFile.mockReset();
});

afterEach(async () => {
  await rm(state.homedir, { recursive: true, force: true });
});

describe('withCodexNativeStartupLock', () => {
  function startup(root: string, versionOutput = 'codex-cli 0.162.1') {
    return { processEnv: { CODEX_HOME: join(state.homedir, 'auth-home'), CODEX_SQLITE_HOME: root }, cwd: state.homedir, versionOutput };
  }

  async function completeDatabase(root: string) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'state_5.sqlite'), 'SQLite format 3\0');
  }

  it('serializes fresh starts across both the same and different roots through readiness', async () => {
    const rootA = join(state.homedir, 'a');
    const rootB = join(state.homedir, 'b');
    const entered: string[] = [];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const start = (root: string, id: string) => withCodexNativeStartupLock(10, async () => {
      entered.push(id); await held; await completeDatabase(root);
    }, undefined, startup(root));
    const starts = [start(rootA, 'a')];
    try {
      await vi.waitFor(() => expect(entered).toEqual(['a']));
      starts.push(start(rootA, 'a2'), start(rootB, 'b'));
      await vi.waitFor(() => expect(state.infoFile).toHaveBeenCalledTimes(2));
      expect(entered).toEqual(['a']);
    } finally { release(); await Promise.all(starts); }
    expect([...entered].sort()).toEqual(['a', 'a2', 'b']);
  });

  it.each([false, true])('excludes a fresh known root and unresolved start sharing SQLite, unresolved first=%s', async unresolvedFirst => {
    const root = join(state.homedir, 'sqlite');
    const unresolvedHome = join(state.homedir, 'cloud-auth');
    await mkdir(unresolvedHome);
    await writeFile(join(unresolvedHome, 'auth.json'), '{}');
    const known = startup(root);
    const unresolved = { ...known, processEnv: { ...known.processEnv, CODEX_HOME: unresolvedHome } };
    const configurations = unresolvedFirst ? [unresolved, known] : [known, unresolved];
    const entered: number[] = [];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withCodexNativeStartupLock(10, async () => { entered.push(1); await held; await completeDatabase(root); }, undefined, configurations[0]);
    await vi.waitFor(() => expect(entered).toEqual([1]));
    const second = withCodexNativeStartupLock(10, async () => { entered.push(2); }, undefined, configurations[1]);
    try {
      await vi.waitFor(() => expect(state.infoFile).toHaveBeenCalledOnce());
      expect(entered).toEqual([1]);
    } finally { release(); await first; await second; }
    expect(entered).toEqual([1, 2]);
  });

  it('admits warm same-version starts together and excludes version-change starts', async () => {
    const root = join(state.homedir, 'sqlite');
    await withCodexNativeStartupLock(10, async () => completeDatabase(root), undefined, startup(root));
    expect(await readFile(join(root, '.happier-codex-native-startup.version'), 'utf8')).toBe('0.162.1\n');
    const entered: number[] = [];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const warm = [1, 2].map(id => withCodexNativeStartupLock(10, async () => { entered.push(id); await held; }, undefined, startup(root)));
    try { await vi.waitFor(() => expect(entered).toHaveLength(2)); }
    finally { release(); await Promise.all(warm); }
    const nextHeld = new Promise<void>(resolve => { release = resolve; });
    const first = withCodexNativeStartupLock(10, async () => { entered.push(3); await nextHeld; }, undefined, startup(root, 'codex-cli 0.163.0'));
    let second: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toContain(3));
      second = withCodexNativeStartupLock(10, async () => { entered.push(4); }, undefined, startup(root, 'codex-cli 0.163.0'));
      await vi.waitFor(() => expect(state.infoFile).toHaveBeenCalledOnce());
      expect(entered).not.toContain(4);
    } finally { release(); await first; await second; }
  });

  it('pins the root used by launch and never publishes failed readiness as warm', async () => {
    const root = join(state.homedir, 'sqlite');
    await expect(withCodexNativeStartupLock(10, async overrides => {
      expect(overrides).toEqual(['model="kept"', `sqlite_home=${JSON.stringify(root)}`]);
      await completeDatabase(root);
      throw new Error('initialize failed');
    }, undefined, { ...startup(root), configOverrides: ['model="kept"'] })).rejects.toThrow('initialize failed');
    await expect(readFile(join(root, '.happier-codex-native-startup.version'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the initialized resource even if its warm marker cannot be published', async () => {
    const root = join(state.homedir, 'sqlite');
    const resource = { dispose: vi.fn() };
    await expect(withCodexNativeStartupLock(10, async () => {
      await completeDatabase(root);
      await mkdir(join(root, '.happier-codex-native-startup.version'));
      return resource;
    }, undefined, startup(root))).resolves.toBe(resource);
    expect(resource.dispose).not.toHaveBeenCalled();
    expect(state.infoFile).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'disk authentication', file: 'auth.json', override: 'model="kept"' },
    { name: 'uninspected config', file: 'config.toml', override: 'model="kept"' },
    { name: 'cloud requirements', file: 'cloud-config-bundle-cache.json', override: 'model="kept"' },
    { name: 'explicit SQLite config', file: null, override: 'sqlite_home="native-choice"' },
    { name: 'explicit keyring config', file: null, override: 'cli_auth_credentials_store="keyring"' },
  ])('keeps $name globally excluded while pinning projected SQLite unless the caller overrides it', async ({ file, override }) => {
    const configuration = startup(join(state.homedir, 'sqlite'));
    if (file) {
      await mkdir(configuration.processEnv.CODEX_HOME, { recursive: true });
      await writeFile(join(configuration.processEnv.CODEX_HOME, file), '{}');
    }
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const owner = withCodexNativeStartupLock(10, async () => { await held; });
    await vi.waitFor(async () => expect(await readFile(join(state.homedir, '.happier-codex-native-startup.lock'), 'utf8')).toContain(String(process.pid)));
    const initialize = vi.fn(async (_overrides: readonly string[]) => 'started');
    const contender = withCodexNativeStartupLock(10, initialize, undefined, { ...configuration, configOverrides: [override] });
    try {
      await vi.waitFor(() => expect(state.infoFile).toHaveBeenCalledOnce());
      expect(initialize).not.toHaveBeenCalled();
    } finally { release(); await owner; await contender; }
    expect(initialize).toHaveBeenCalledWith([
      override,
      ...(override.startsWith('sqlite_home=') ? [] : [`sqlite_home=${JSON.stringify(configuration.processEnv.CODEX_SQLITE_HOME)}`]),
    ]);
    await expect(readFile(join(configuration.processEnv.CODEX_SQLITE_HOME, '.happier-codex-native-startup.version'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not treat an empty state database as completed even with a matching marker', async () => {
    const root = join(state.homedir, 'sqlite');
    await mkdir(root);
    await writeFile(join(root, 'state_5.sqlite'), '');
    await writeFile(join(root, '.happier-codex-native-startup.version'), '0.162.1\n');
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    const first = withCodexNativeStartupLock(10, async () => { entered(); await held; }, undefined, startup(root));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const second = withCodexNativeStartupLock(10, async () => { entered(); }, undefined, startup(root));
    try {
      await vi.waitFor(() => expect(state.infoFile).toHaveBeenCalledOnce());
      expect(entered).toHaveBeenCalledOnce();
    } finally { release(); await first; await second; }
  });

  it('logs one file diagnostic for a queued start and preserves the holder on cancellation', async () => {
    let releaseOwner = () => {};
    let markEntered = () => {};
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const owner = withCodexNativeStartupLock(10, async () => { markEntered(); await released; });
    const controller = new AbortController();
    let contender: Promise<void> | undefined;
    try {
      await entered;
      expect(state.infoFile).not.toHaveBeenCalled();
      const lockPath = join(state.homedir, '.happier-codex-native-startup.lock');
      const originalOwner = await readFile(lockPath, 'utf8');
      contender = withCodexNativeStartupLock(10, async () => {
        throw new Error('Queued start acquired the active lock');
      }, controller.signal);
      await vi.waitFor(() => expect(state.infoFile).toHaveBeenCalledOnce());
      expect(state.infoFile).toHaveBeenCalledWith(expect.any(String), {
        pid: process.pid, heldForMs: expect.any(Number), waitedForMs: expect.any(Number),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(state.infoFile).toHaveBeenCalledOnce();
      const cancelled = expect(contender).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await cancelled;
      expect(await readFile(lockPath, 'utf8')).toBe(originalOwner);
    } finally {
      controller.abort();
      await contender?.catch(() => {});
      releaseOwner();
      await owner;
    }
    await expect(withCodexNativeStartupLock(10, async () => 'started')).resolves.toBe('started');
    expect(state.infoFile).toHaveBeenCalledOnce();
  });
});

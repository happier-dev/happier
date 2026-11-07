import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPath, classifyPaths, classifyPhysicalPath, storageSystemPartitionReason, type StorageProtectionFacts } from './protectedPaths';
import { physicalPathWithoutFollowingLeaf } from '@/utils/path/physicalAncestorPath';
import { createDaemonEventLoopStallMonitor } from '@/daemon/diagnostics/daemonEventLoopStallMonitor';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { logger } from '@/ui/logger';
import { withStorageReadTrace } from '@/daemon/externalActions/webLatencyTrace';
import * as filesystem from 'node:fs/promises';
import { storagePathFromBytes } from '../storagePath';

// Observe actual filesystem work; physical-path and protection logic remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const fixtures: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-protection-'))); fixtures.push(root);
  const home = join(root, 'home'); await mkdir(home);
  return { root, home };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('storage physical path protection', () => {
  it.skipIf(process.platform === 'win32')('excludes boot partitions without excluding user data mounts or sibling prefixes', () => {
    expect(storageSystemPartitionReason('/boot/efi')).toBe('system_partition');
    expect(storageSystemPartitionReason('/efi/EFI')).toBe('system_partition');
    for (const path of ['/System/Volumes/Data', '/mnt/data', '/boot-data', '/efiles']) {
      expect(storageSystemPartitionReason(path)).toBeUndefined();
    }
  });
  it('refuses deployment trees and symlink aliases even for a managed catalog item', async () => {
    const { root, home } = await fixture();
    const happyHomeDir = join(home, '.happier'); const serversDir = join(happyHomeDir, 'servers');
    const activeServerDir = join(serversDir, 'active');
    const physicalServers = join(root, 'physical-servers');
    await Promise.all([mkdir(happyHomeDir), mkdir(physicalServers)]);
    await symlink(physicalServers, serversDir, 'junction');
    const deploymentRoot = join(activeServerDir, 'deployments');
    const retainedRoot = join(happyHomeDir, 'servers', 'retained', 'deployments');
    const release = join(deploymentRoot, 'environment', 'releases', 'receipt');
    const shared = join(deploymentRoot, 'environment', 'shared');
    await Promise.all([release, shared, retainedRoot].map(path => mkdir(path, { recursive: true })));
    const alias = join(root, 'release-alias'); await symlink(release, alias, 'junction');
    const retainedAlias = join(root, 'retained-alias'); await symlink(retainedRoot, retainedAlias, 'junction');
    const facts = { homeDir: home, deploymentPaths: { serversDir, activeServerDir } };
    expect(await classifyPath(home, facts)).toMatchObject({ tier: 'forbidden', reason: { code: 'home_folder' } });
    expect(classifyPhysicalPath('/', facts)).toMatchObject({ tier: 'forbidden', reason: { code: 'root' } });
    for (const path of [deploymentRoot, release, shared, join(shared, 'data'), alias, join(alias, 'data'), retainedAlias]) {
      expect(await classifyPath(path, { ...facts, managedItemPath: path }), path).toMatchObject({ tier: 'forbidden' });
    }
    expect((await classifyPath(alias, { ...facts, userProtectedFolders: [alias] })).tier).toBe('forbidden');
    const ordinaryTarget = join(root, 'ordinary-target'); await mkdir(ordinaryTarget);
    const ordinaryAlias = join(root, 'ordinary-alias'); await symlink(ordinaryTarget, ordinaryAlias, 'junction');
    expect((await classifyPath(ordinaryAlias, facts)).tier).toBeNull();
    if (process.platform !== 'win32') {
      const loop = join(root, 'loop'); await symlink(loop, loop);
      expect((await classifyPath(loop, facts)).tier).toBeNull();
      const ordinaryBytes = Buffer.concat([Buffer.from(join(root, 'ordinary-')), Buffer.from([255])]);
      const deploymentBytes = Buffer.concat([Buffer.from(join(release, 'child-')), Buffer.from([255])]);
      await Promise.all([mkdir(ordinaryBytes), mkdir(deploymentBytes)]);
      expect((await classifyPath(storagePathFromBytes(ordinaryBytes), facts)).tier).toBeNull();
      expect((await classifyPath(storagePathFromBytes(deploymentBytes), facts)).tier).toBe('forbidden');
    }
    expect((await classifyPath(`${deploymentRoot}-ordinary`, facts)).tier).toBeNull();
    expect((await classifyPath(join(root, 'ordinary'), facts)).tier).toBeNull();
  });
  it('resolves a summary inventory parent once per observation, including managed aliases', async () => {
    const { root, home } = await fixture();
    const logs = join(home, 'logs'); await mkdir(logs);
    const alias = join(root, 'alias'); await symlink(logs, alias, 'junction');
    const paths = Array.from({ length: 1200 }, (_, index) => join(alias, `${index}.log`));
    const candidates = paths.map(path => ({ path, managedItemPath: path }));
    const reads = vi.mocked(filesystem.realpath);
    for (let observation = 0; observation < 2; observation++) {
      const before = reads.mock.calls.length;
      const result = await classifyPaths(candidates, { homeDir: home,
        deploymentPaths: { serversDir: join(home, '.happier', 'servers'), activeServerDir: join(home, '.happier', 'servers', 'active') } });
      expect(result.every(value => value.tier === null)).toBe(true);
      // The exact names need their shared physical parent, never 2N identical realpaths.
      expect(reads.mock.calls.slice(before).filter(([path]) => path === alias)).toHaveLength(1);
    }
  });
  it('keeps diagnostic work proportional to phases rather than candidate rows', async () => {
    const { home } = await fixture(); const path = join(home, 'cache'); await mkdir(path);
    const traceEnv = createEnvKeyScope(['HAPPIER_WEB_LATENCY_TRACE', 'HAPPIER_LOG_LEVEL']);
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      traceEnv.patch({ HAPPIER_WEB_LATENCY_TRACE: '1', HAPPIER_LOG_LEVEL: 'debug' });
      const stages: number[] = [];
      for (const rows of [1, 1000]) {
        debug.mockClear();
        const result = await withStorageReadTrace('rpc_classification-cost', () => classifyPaths(
          Array.from({ length: rows }, () => ({ path, managedItemPath: path })), { homeDir: home }));
        expect(result).toEqual(Array.from({ length: rows }, () => ({ tier: null })));
        stages.push(debug.mock.calls.length);
      }
      expect(stages[0]).toBeGreaterThan(0);
      expect(stages[1]).toBe(stages[0]);
    } finally { debug.mockRestore(); traceEnv.restore(); }
  });
  it('projects repeated Session process bindings without starving the daemon or losing a holder', async () => {
    const paths = Array.from({ length: 1500 }, (_, index) => `/projects/work-${index % 15}`);
    const warnings: Readonly<Record<string, unknown>>[] = [];
    const monitor = createDaemonEventLoopStallMonitor({ getActiveRpcOperations: () => [],
      warn: (_message, data) => warnings.push(data) });
    const traceEnv = createEnvKeyScope(['HAPPIER_WEB_LATENCY_TRACE']);
    try {
      traceEnv.patch({ HAPPIER_WEB_LATENCY_TRACE: '1' });
      monitor.start();
      const result = classifyPhysicalPath('/projects', { homeDir: '/people/alice', platform: 'linux',
        inUsePaths: paths, inUseSessions: paths.map((path, index) => ({ path, sessionId: `session-${index % 15}` })) });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(result.loses).toHaveLength(15);
      expect(new Set(result.loses?.map(reason => reason.detail?.sessionId)).size).toBe(15);
      expect(warnings).toEqual([]);
    } finally { monitor.stop(); traceEnv.restore(); }
  });
  it('shares only one read’s physical rules, preserving managed children, aliases and fresh protection', async () => {
    const { root, home } = await fixture();
    const data = join(home, '.happier'); const child = join(data, 'cache');
    const system = join(root, 'system'); const alias = join(home, 'alias');
    await mkdir(child, { recursive: true }); await mkdir(join(system, 'child'), { recursive: true });
    await symlink(system, alias, 'junction');
    const candidates = [{ path: data, managedItemPath: data }, { path: child, managedItemPath: child },
      { path: child }, { path: alias }, { path: join(alias, 'child') }];
    const facts = { homeDir: home, dataHomes: [data], systemPaths: [system] };
    const first = await classifyPaths(candidates, facts);
    expect(first.map(value => value.tier)).toEqual(['forbidden', null, 'forbidden', null, 'forbidden']);
    expect(await classifyPaths(candidates, facts)).toEqual(await Promise.all(candidates.map(candidate =>
      classifyPath(candidate.path, { ...facts, managedItemPath: candidate.managedItemPath }))));
    expect((await classifyPaths([{ path: child, managedItemPath: child }], { ...facts, userProtectedFolders: [child] }))[0].tier).toBe('keep');
    const aliasFacts = { homeDir: home, dataHomes: [data], systemPaths: [alias] };
    const managedChild = [{ path: child, managedItemPath: child }];
    expect((await classifyPaths(managedChild, aliasFacts))[0].tier).toBeNull();
    // A different read resolves a changed OS symlink afresh, not a retained rule cache.
    await rm(alias); await symlink(data, alias, 'junction');
    expect((await classifyPaths(managedChild, aliasFacts))[0].tier).toBe('forbidden');
  });
  it.skipIf(process.platform !== 'win32')('keeps private and locked Windows system leaves protected without blocking ordinary NTFS candidates', async () => {
    const { home } = await fixture(); const cache = join(home, 'cache'); await mkdir(cache);
    const drive = process.env.SystemDrive ?? win32.parse(home).root;
    const facts = { homeDir: home, env: process.env };
    expect((await classifyPath(cache, facts)).tier).toBeNull();
    expect((await classifyPath(win32.join(drive, 'System Volume Information'), facts)).tier).toBe('forbidden');
    expect((await classifyPath(win32.join(drive, 'pagefile.sys'), facts)).tier).toBe('forbidden');
  });

  it('resolves parents but keeps a symlink leaf as the target being removed', async () => {
    const { root, home } = await fixture();
    const system = join(root, 'system'); await mkdir(system); await mkdir(join(system, 'child'));
    const alias = join(home, 'alias'); await symlink(system, alias, 'junction');
    const facts = { homeDir: home, systemPaths: [system],
      deploymentPaths: { serversDir: join(home, '.happier', 'servers'), activeServerDir: join(home, '.happier', 'servers', 'active') } };
    expect(await physicalPathWithoutFollowingLeaf(join(alias, 'child'))).toBe(join(system, 'child'));
    expect(await physicalPathWithoutFollowingLeaf(alias)).toBe(alias);
    expect((await classifyPath(join(alias, 'child'), facts)).tier).toBe('forbidden');
    expect((await classifyPath(alias, facts)).tier).toBeNull();
  });
  it('protects containers of roots and checkouts without forbidding all verified managed children', async () => {
    const { home } = await fixture(); const data = join(home, '.happier'); const cache = join(data, 'cache');
    const project = join(home, 'projects', 'main'); await mkdir(cache, { recursive: true }); await mkdir(project, { recursive: true });
    expect((await classifyPath(data, { homeDir: home, dataHomes: [data], managedItemPath: data })).tier).toBe('forbidden');
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [data], managedItemPath: cache })).tier).toBeNull();
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [data] })).tier).toBe('forbidden');
    expect(await classifyPath(join(home, 'projects'), { homeDir: home, mainCheckouts: [project] })).toMatchObject({ tier: 'keep', reason: { code: 'contains' } });
    expect((await classifyPath(home, { homeDir: home })).tier).toBe('forbidden');
  });
  it('rechecks current protected folders and cloud ancestors, with sibling boundaries', async () => {
    const { home } = await fixture(); const shared = join(home, 'projects', 'cloud'); await mkdir(shared, { recursive: true });
    expect((await classifyPath(join(home, 'projects'), { homeDir: home, cloudSyncedFolders: [shared] })).tier).toBe('caution');
    expect((await classifyPath(shared, { homeDir: home, userProtectedFolders: [shared] })).tier).toBe('keep');
    expect((await classifyPath(`${shared}2`, { homeDir: home, userProtectedFolders: [shared] })).tier).toBeNull();
  });
  it('classifies every planned OS system location from platform facts, including relocated Windows roots', () => {
    const unix: StorageProtectionFacts = { homeDir: '/people/alice', platform: 'linux', volumeRoots: ['/disk'] };
    for (const path of ['/', '/disk', '/System', '/usr', '/bin', '/sbin', '/etc', '/boot', '/efi', '/var/lib', '/var/db', '/private/var/db', '/private/var/vm', '/Users', '/home']) {
      expect(classifyPhysicalPath(path, unix).tier, path).toBe('forbidden');
    }
    expect(classifyPhysicalPath('/usr/local/rebuildable', unix).tier).toBeNull();
    const windows: StorageProtectionFacts = { platform: 'win32', homeDir: 'D:\\Users\\Alice', volumeRoots: ['D:\\', 'E:\\'], env: {
      ...process.env, SystemDrive: 'D:', windir: 'D:\\OS', ProgramFiles: 'D:\\Apps', ProgramData: 'D:\\Data', LOCALAPPDATA: 'D:\\Users\\Alice\\Local', APPDATA: 'D:\\Users\\Alice\\Roaming' } };
    for (const path of ['D:\\', 'E:\\', 'D:\\OS\\System32', 'D:\\System Volume Information', 'D:\\Recovery', 'D:\\Boot',
      'D:\\Apps\\WindowsApps', 'D:\\Data\\Microsoft', 'D:\\pagefile.sys', 'D:\\hiberfil.sys', 'D:\\swapfile.sys', 'D:\\Users', 'D:\\Users\\Alice\\ntuser.dat']) {
      expect(classifyPhysicalPath(path, windows).tier, path).toBe('forbidden');
    }
    expect(classifyPhysicalPath('D:\\Users\\Alice2\\cache', windows).tier).toBeNull();
    expect(classifyPhysicalPath('D:\\Users', { ...windows, homeDir: 'E:\\People\\Alice' }).tier).toBe('forbidden');
    const deploymentPaths = { serversDir: 'D:\\Data\\Happier\\servers', activeServerDir: 'D:\\Data\\Happier\\servers\\active' };
    const deploymentFacts = { ...windows, deploymentPaths };
    for (const path of ['d:/DATA/HAPPIER/servers/ACTIVE/deployments/environment/releases/receipt',
      'D:\\DATA\\HAPPIER\\SERVERS\\Retained\\DEPLOYMENTS\\environment\\shared',
      '\\\\?\\D:\\DATA\\HAPPIER\\SERVERS\\Retained\\DEPLOYMENTS\\environment\\shared']) {
      expect(classifyPhysicalPath(path, { ...deploymentFacts, managedItemPath: path }).tier, path).toBe('forbidden');
    }
    for (const path of ['D:\\Data\\Happier2\\servers\\active\\deployments',
      'D:\\Data\\Happier\\servers\\retained\\deployments-ordinary', 'D:\\Data\\Happier\\ordinary']) {
      expect(classifyPhysicalPath(path, deploymentFacts).tier, path).toBeNull();
    }
    expect(classifyPhysicalPath('D:\\', deploymentFacts)).toMatchObject({ tier: 'forbidden', reason: { code: 'root' } });
    expect(classifyPhysicalPath(windows.homeDir, deploymentFacts)).toMatchObject({ tier: 'forbidden', reason: { code: 'home_folder' } });
  });
  it('preserves Keep confirmations for all built-in personal and credential paths and normalized protected identities', () => {
    const facts: StorageProtectionFacts = { homeDir: '/people/alice', platform: 'darwin', userProtectedFolders: ['/people/alice/Café'],
      mainCheckouts: ['/projects/main'], inUsePaths: ['/work/live'], agentHomes: ['/agents/home'], browserProfileRoots: ['/browser/Default'] };
    for (const path of ['Documents', 'Desktop', 'Pictures', 'Music', 'Movies', 'Videos', 'Downloads', 'Library', '.ssh', '.gnupg', '.password-store', '.gitconfig', '.bashrc', '.zshrc',
      'Library/Preferences', 'Library/Keychains', 'Library/Mobile Documents']) {
      expect(classifyPhysicalPath(`/people/alice/${path}`, facts).tier, path).toBe('keep');
    }
    for (const path of ['/srv', '/root', '/nix', '/snap', '/opt', '/mnt', '/media', '/Applications', '/projects/main', '/work/live/child', '/agents/home/child',
      '/browser/Default', '/browser/Default/Cookies', '/browser/Default/Local Storage', '/people/alice/Cafe\u0301/child']) {
      expect(classifyPhysicalPath(path, facts).tier, path).toBe('keep');
    }
    expect(classifyPhysicalPath('/browser/Default/Cache', facts).tier).toBeNull();
    expect(classifyPhysicalPath('/projects', facts)).toMatchObject({ tier: 'keep', reason: { code: 'contains' }, loses: [{ code: 'main_checkout' }] });
    const windows = { ...facts, platform: 'win32' as const, homeDir: 'D:\\Users\\Alice', userProtectedFolders: ['D:\\Users\\Alice\\Protected'] };
    expect(classifyPhysicalPath('\\\\?\\D:\\USERS\\ALICE\\PROTECTED\\child', windows).tier).toBe('keep');
  });
  it('refuses a managed candidate containing protected data, even if its own owner says Safe', async () => {
    const { home } = await fixture(); const cache = join(home, '.happier', 'cache'); const credentials = join(cache, 'keys'); await mkdir(credentials, { recursive: true });
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [join(home, '.happier')], managedItemPath: cache, userProtectedFolders: [credentials] })).tier).toBe('keep');
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [join(home, '.happier')], managedItemPath: cache, trashRoots: [credentials] })).tier).toBe('forbidden');
  });
  it('expands user-protected home aliases through the canonical owner using this machine home', async () => {
    const { home } = await fixture(); const path = join(home, 'protected', 'child'); await mkdir(path, { recursive: true });
    expect((await classifyPath(path, { homeDir: home, userProtectedFolders: ['~\\protected'] })).tier).toBe('keep');
    expect((await classifyPath('~/protected/child', { homeDir: home, userProtectedFolders: ['~/protected/'] })).tier).toBe('keep');
  });
  it('names every kept descendant in the confirmation and identifies cloud effects in typed detail', () => {
    const facts = { homeDir: '/people/alice', platform: 'linux' as const, mainCheckouts: ['/projects/one', '/projects/two'] };
    expect(classifyPhysicalPath('/projects', facts).loses).toEqual([
      { code: 'main_checkout', detail: { path: '/projects/one' } }, { code: 'main_checkout', detail: { path: '/projects/two' } },
    ]);
    expect(classifyPhysicalPath('/cloud/files', { ...facts, cloudSyncedFolders: ['/cloud'] }).reason?.detail).toMatchObject({ cloudSynced: true });
    expect(classifyPhysicalPath('/projects', { ...facts, mainCheckouts: [], cloudSyncedFolders: ['/projects/cloud'] }).reason?.detail).toMatchObject({ cloudSynced: true, containsSyncedFolder: true });
    expect(classifyPhysicalPath('/projects', { ...facts, cloudSyncedFolders: ['/projects'] }).loses).toContainEqual({
      code: 'not_rebuildable', detail: { path: '/projects', cloudSynced: true },
    });
  });
  it('names each holding Session without attributing non-Session holders or choosing only the first holder', () => {
    const facts: StorageProtectionFacts = { homeDir: '/people/alice', platform: 'linux',
      inUsePaths: ['/projects/one', '/projects/other', '/projects/one'],
      inUseSessions: [{ path: '/projects/one', sessionId: 's1' }, { path: '/projects/one', sessionId: 's2' },
        { path: '/projects/one', sessionId: 's1' }] };
    const result = classifyPhysicalPath('/projects', facts);
    expect(result.loses).toEqual([
      { code: 'in_use', detail: { path: '/projects/one', sessionId: 's1' } },
      { code: 'in_use', detail: { path: '/projects/one', sessionId: 's2' } },
      { code: 'in_use', detail: { path: '/projects/other' } },
    ]);
    expect(classifyPhysicalPath('/projects/one/child', facts).reason).toMatchObject({ code: 'in_use', detail: { sessionId: 's1' } });
  });
});

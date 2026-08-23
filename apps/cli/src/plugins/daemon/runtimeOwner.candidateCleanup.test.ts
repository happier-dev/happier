import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCurrentGlobalExternalSessionsRouter,
} from '@/session/external/currentGlobalRouting';

import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';

const ownerMocks = vi.hoisted(() => ({
  initializeStore: vi.fn(async () => undefined),
  releaseInitialLease: vi.fn(async () => undefined),
}));

vi.mock('@/plugins/daemon/archiveChangePreparer', () => ({
  createDaemonArchivePluginChangePreparer: () => vi.fn(),
}));
vi.mock('@/plugins/daemon/changeService', () => ({
  createDaemonPluginChangeService: () => Object.freeze({
    requestPluginChange: vi.fn(),
    decidePluginChange: vi.fn(),
    runHardRevocationCurrentnessChange: vi.fn(),
    quiesceForHandoff: vi.fn(),
    shutdown: vi.fn(),
  }),
}));
vi.mock('@/plugins/daemon/npmChangePreparer', () => ({
  createDaemonNpmPluginChangePreparer: () => vi.fn(),
}));
vi.mock('@/plugins/daemon/pathChangePreparer', () => ({
  createDaemonPathPluginChangePreparer: () => vi.fn(),
}));
vi.mock('@/plugins/daemon/currentCatalog', () => ({
  readCurrentDaemonPluginCatalog: vi.fn(async () => []),
}));
vi.mock('@/plugins/runtime/reload/registryRuntimeLifecycle', () => ({
  createDaemonPluginRegistryRuntimeLifecycle: () => Object.freeze({}),
}));
vi.mock('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
  resolveExecutablePluginRuntimeRegistry: vi.fn(async () => Object.freeze({
    contributes: Object.freeze({ generationId: 'candidate-generation' }),
  })),
}));
vi.mock('@/plugins/store/registry/currentState', () => ({
  createPluginRegistryStateStore: () => Object.freeze({
    initialize: ownerMocks.initializeStore,
  }),
}));
vi.mock('@/ui/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { createDaemonPluginRuntimeOwner } from './runtimeOwner';
import {
  createDaemonPluginCandidateOperationRoot,
  type DaemonPluginCandidateKind,
} from './candidateStorage';

const temporaryHomes = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryHomes].map(async (path) => await rm(path, { recursive: true, force: true })),
  );
  temporaryHomes.clear();
  vi.clearAllMocks();
});

function createUnusedConnectedAccountsOwner(): StablePluginConnectedAccountsOwner {
  return Object.freeze({
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(async () => {
      throw new Error('unexpected connected-account selection');
    }),
    materialize: vi.fn(async () => {
      throw new Error('unexpected connected-account materialization');
    }),
    listAccounts: async () => {
        throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
        throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch: vi.fn(() => Object.freeze({ dispose() {} })),
  });
}

function createReloadController(): PluginReloadController {
  return {
    adoptPreparedRuntimeRegistry: vi.fn(async () => {
      throw new Error('unexpected prepared-registry adoption');
    }),
    acquireRuntimeRegistry: vi.fn(async (params = {}) => {
      const registry = await params.resolveRuntimeRegistry?.();
      if (!registry) throw new Error('missing initial registry');
      return Object.freeze({
        registry,
        source: 'active' as const,
        release: ownerMocks.releaseInitialLease,
      });
    }),
    tryAcquireRuntimeRegistry: vi.fn(() => null),
    isRuntimeRegistryCurrent: vi.fn(() => false),
    applyResourceSessionAccessWitness: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    getState: () => Object.freeze({
      generation: 0,
      activeRegistry: null,
      lastResult: null,
    }),
    subscribe: vi.fn(() => () => undefined),
    publishDurableRunningSessionDisposition: vi.fn(),
    currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
      () => null,
    ),
    subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
  };
}

async function createRuntimeOwnerHome(): Promise<Readonly<{
  happyHomeDir: string;
  staleCandidateSentinels: readonly string[];
  protectedSentinels: readonly string[];
  candidateNamedSymlinkSentinel: string;
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-owner-cleanup-'));
  temporaryHomes.add(happyHomeDir);
  const pluginRoot = join(happyHomeDir, 'plugins', 'plugins');
  const cacheDir = join(pluginRoot, 'cache');
  const staleDevelopmentRoot = join(
    cacheDir,
    'development-candidates',
    'candidate-crashed-development',
  );
  const staleArchiveRoot = join(cacheDir, 'plugin-archive-candidate-crashed-archive');
  const staleNpmRoot = join(cacheDir, 'plugin-npm-candidate-crashed-npm');
  const unrelatedCacheRoot = join(cacheDir, 'plugin-archive-candidates-user-content');
  const currentGenerationRoot = join(
    pluginRoot,
    'generations',
    'plugin-npm-candidate-current-generation',
  );
  const userRoot = join(happyHomeDir, 'user-path');
  const candidateNamedFile = join(cacheDir, 'plugin-archive-candidate-user-file');
  const candidateNamedSymlink = join(cacheDir, 'plugin-npm-candidate-user-link');
  await Promise.all([
    mkdir(staleDevelopmentRoot, { recursive: true }),
    mkdir(staleArchiveRoot, { recursive: true }),
    mkdir(staleNpmRoot, { recursive: true }),
    mkdir(unrelatedCacheRoot, { recursive: true }),
    mkdir(currentGenerationRoot, { recursive: true }),
    mkdir(userRoot, { recursive: true }),
  ]);
  const staleCandidateSentinels = [
    join(staleDevelopmentRoot, 'sentinel.txt'),
    join(staleArchiveRoot, 'sentinel.txt'),
    join(staleNpmRoot, 'sentinel.txt'),
  ];
  const protectedSentinels = [
    join(unrelatedCacheRoot, 'sentinel.txt'),
    join(currentGenerationRoot, 'sentinel.txt'),
    join(userRoot, 'sentinel.txt'),
    candidateNamedFile,
  ];
  await Promise.all([
    ...staleCandidateSentinels.map(async (path) => await writeFile(path, 'remove')),
    ...protectedSentinels.map(async (path) => await writeFile(path, 'preserve')),
  ]);
  await symlink(
    userRoot,
    candidateNamedSymlink,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return Object.freeze({
    happyHomeDir,
    staleCandidateSentinels: Object.freeze(staleCandidateSentinels),
    protectedSentinels: Object.freeze(protectedSentinels),
    candidateNamedSymlinkSentinel: join(candidateNamedSymlink, 'sentinel.txt'),
  });
}

type CandidateParentAliasKind = 'plugin-root' | 'cache' | 'development-candidates';

async function createAliasedCandidateParentHome(
  kind: CandidateParentAliasKind,
): Promise<Readonly<{
  happyHomeDir: string;
  candidateKind: DaemonPluginCandidateKind;
  externalCandidateParentPath: string;
  externalSentinels: readonly string[];
}>> {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-owner-alias-home-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-owner-alias-target-'));
  temporaryHomes.add(happyHomeDir);
  temporaryHomes.add(externalRoot);

  let candidateKind: DaemonPluginCandidateKind;
  let externalCandidateParentPath: string;
  let externalCandidateRoots: readonly string[];
  if (kind === 'plugin-root') {
    candidateKind = 'archive';
    externalCandidateParentPath = join(externalRoot, 'plugins', 'cache');
    externalCandidateRoots = [
      join(externalCandidateParentPath, 'plugin-archive-candidate-external'),
      join(externalCandidateParentPath, 'plugin-npm-candidate-external'),
    ];
    await mkdir(join(happyHomeDir), { recursive: true });
    await symlink(
      externalRoot,
      join(happyHomeDir, 'plugins'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } else if (kind === 'cache') {
    candidateKind = 'npm';
    externalCandidateParentPath = externalRoot;
    externalCandidateRoots = [
      join(externalCandidateParentPath, 'plugin-archive-candidate-external'),
      join(externalCandidateParentPath, 'plugin-npm-candidate-external'),
    ];
    const pluginRoot = join(happyHomeDir, 'plugins', 'plugins');
    await mkdir(pluginRoot, { recursive: true });
    await symlink(
      externalRoot,
      join(pluginRoot, 'cache'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } else {
    candidateKind = 'development';
    externalCandidateParentPath = externalRoot;
    externalCandidateRoots = [join(externalCandidateParentPath, 'candidate-external')];
    const cacheDir = join(happyHomeDir, 'plugins', 'plugins', 'cache');
    await mkdir(cacheDir, { recursive: true });
    await symlink(
      externalRoot,
      join(cacheDir, 'development-candidates'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  await Promise.all(externalCandidateRoots.map(async (path) => await mkdir(path, { recursive: true })));
  const externalSentinels = externalCandidateRoots.map((path) => join(path, 'sentinel.txt'));
  await Promise.all(externalSentinels.map(async (path) => await writeFile(path, 'preserve')));
  return Object.freeze({
    happyHomeDir,
    candidateKind,
    externalCandidateParentPath,
    externalSentinels: Object.freeze(externalSentinels),
  });
}

describe('createDaemonPluginRuntimeOwner candidate crash cleanup', () => {
  it('removes only daemon-owned crashed candidate roots before registry startup', async () => {
    const fixture = await createRuntimeOwnerHome();
    ownerMocks.initializeStore.mockImplementationOnce(async () => {
      await Promise.all(fixture.staleCandidateSentinels.map(async (path) => {
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }));
    });
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: fixture.happyHomeDir,
      staleCandidateCleanup: 'exclusiveHome',
      reloadController: createReloadController(),
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    for (const path of fixture.staleCandidateSentinels) {
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const path of fixture.protectedSentinels) {
      await expect(readFile(path, 'utf8')).resolves.toBe('preserve');
    }
    await expect(readFile(fixture.candidateNamedSymlinkSentinel, 'utf8')).resolves.toBe('preserve');
  });

  it('does not sweep candidates without exclusive happy-home ownership', async () => {
    const fixture = await createRuntimeOwnerHome();
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: fixture.happyHomeDir,
      staleCandidateCleanup: 'disabled',
      reloadController: createReloadController(),
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    for (const path of fixture.staleCandidateSentinels) {
      await expect(readFile(path, 'utf8')).resolves.toBe('remove');
    }
  });

  it.each([
    'plugin-root',
    'cache',
    'development-candidates',
  ] as const)('fails closed without touching candidates through an aliased %s parent', async (kind) => {
    const fixture = await createAliasedCandidateParentHome(kind);
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: fixture.happyHomeDir,
      staleCandidateCleanup: 'exclusiveHome',
      reloadController: createReloadController(),
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await expect(owner.initialize()).rejects.toThrow();

    expect(ownerMocks.initializeStore).not.toHaveBeenCalled();
    const externalEntriesBeforeCreation = (await readdir(fixture.externalCandidateParentPath)).sort();
    await expect(createDaemonPluginCandidateOperationRoot({
      happyHomeDir: fixture.happyHomeDir,
      kind: fixture.candidateKind,
    })).rejects.toThrow();
    await expect(readdir(fixture.externalCandidateParentPath))
      .resolves.toEqual(externalEntriesBeforeCreation);
    for (const path of fixture.externalSentinels) {
      await expect(readFile(path, 'utf8')).resolves.toBe('preserve');
    }
  });
});

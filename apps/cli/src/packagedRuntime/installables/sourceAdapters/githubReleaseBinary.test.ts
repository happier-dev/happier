import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { configurationState, concurrencyState } = vi.hoisted(() => ({
  configurationState: { happyHomeDir: '' },
  concurrencyState: {
    pauseFirstPromotion: false,
    onPromotionPaused: null as (() => void) | null,
    promotionRelease: null as Promise<void> | null,
    stagedCandidateCount: 0,
    onSecondCandidateStaged: null as (() => void) | null,
  },
}));

const { downloadMock, extractRootMock, fetchReleaseMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  extractRootMock: vi.fn(),
  fetchReleaseMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      const destinationParts = to.split(/[\\/]/);
      if (from.split(/[\\/]/).includes('extract') && destinationParts.at(-2) === 'bin') {
        concurrencyState.stagedCandidateCount += 1;
        if (concurrencyState.stagedCandidateCount === 2) concurrencyState.onSecondCandidateStaged?.();
      }
      if (concurrencyState.pauseFirstPromotion && destinationParts.at(-1) === 'current') {
        concurrencyState.pauseFirstPromotion = false;
        concurrencyState.onPromotionPaused?.();
        await concurrencyState.promotionRelease;
      }
      return await actual.rename(from, to);
    }),
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return configurationState.happyHomeDir;
    },
    get logsDir() {
      return join(configurationState.happyHomeDir, 'logs');
    },
  },
}));

vi.mock('@/agent/catalog/registry', () => ({
  readCatalogEntriesSnapshot: () => ({}),
}));

vi.mock('@happier-dev/release-runtime/github', () => ({
  fetchGitHubLatestRelease: fetchReleaseMock,
}));

vi.mock('@happier-dev/cli-common/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/agents')>();
  return {
    ...actual,
    downloadGitHubReleaseAsset: downloadMock,
  };
});

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    extractReleasePayloadRootFromArchive: extractRootMock,
  };
});

const tempDirs = new Set<string>();

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

afterEach(async () => {
  concurrencyState.pauseFirstPromotion = false;
  concurrencyState.onPromotionPaused = null;
  concurrencyState.promotionRelease = null;
  concurrencyState.stagedCandidateCount = 0;
  concurrencyState.onSecondCandidateStaged = null;
  vi.clearAllMocks();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

describe('generic GitHub release binary managed source adapter', () => {
  it('selects the Codex ACP host adapter by its installable identity without consulting Agent catalog hooks', async () => {
    const { CODEX_ACP_INSTALLABLE_DESCRIPTOR } = await import(
      '@happier-dev/plugins-codex/agent/installables/codexAcp'
    );
    const { getGitHubReleaseBinaryRuntimeInstallableAdapter } = await import('./githubReleaseBinary');

    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(
      CODEX_ACP_INSTALLABLE_DESCRIPTOR,
    );

    expect(adapter?.detectCapabilityStatus).toBeTypeOf('function');
  });

  it('keeps concurrent installs isolated until their serialized promotions commit', async () => {
    configurationState.happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-github-release-adapter-'));
    tempDirs.add(configurationState.happyHomeDir);
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: 'acme-release-tool',
      key: 'acme-release-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.acme-release-tool',
      display: { name: 'Acme Release Tool' },
      description: 'Test release tool',
      source: { kind: 'github_release_binary', repo: 'acme/release-tool', distTag: 'latest' },
      binary: { commands: ['acme-release-tool'], systemFirst: true, managedFallback: true },
      defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'notify' },
      consent: { install: 'required', update: 'required' },
    });
    const promotionPaused = deferred();
    const releasePromotion = deferred();
    const secondCandidateStaged = deferred();
    const commandFilename = process.platform === 'win32' ? 'acme-release-tool.exe' : 'acme-release-tool';
    let extractedRelease = 0;

    fetchReleaseMock.mockResolvedValue({
      tag_name: 'v1.2.3',
      assets: [{
        name: `acme-release-tool-${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.gz`,
        browser_download_url: 'https://example.invalid/acme-release-tool.tar.gz',
        digest: 'sha256:test',
      }],
    });
    downloadMock.mockImplementation(async (params: { destinationPath: string }) => {
      await writeFile(params.destinationPath, 'archive', 'utf8');
    });
    extractRootMock.mockImplementation(async (params: { extractDir: string }) => {
      extractedRelease += 1;
      const payloadRoot = join(params.extractDir, `release-${extractedRelease}`);
      await mkdir(join(payloadRoot, 'bin'), { recursive: true });
      await writeFile(join(payloadRoot, 'bin', commandFilename), `release-${extractedRelease}`, 'utf8');
      return payloadRoot;
    });
    concurrencyState.pauseFirstPromotion = true;
    concurrencyState.onPromotionPaused = promotionPaused.resolve;
    concurrencyState.promotionRelease = releasePromotion.promise;
    concurrencyState.onSecondCandidateStaged = secondCandidateStaged.resolve;

    try {
      const { getGitHubReleaseBinaryRuntimeInstallableAdapter } = await import('./githubReleaseBinary');
      const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor);
      expect(adapter).not.toBeNull();
      if (!adapter) return;

      const firstPromise = adapter.installOrUpgrade();
      await promotionPaused.promise;
      const secondPromise = adapter.installOrUpgrade();
      await secondCandidateStaged.promise;
      releasePromotion.resolve();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      await expect(readFile(join(
        configurationState.happyHomeDir,
        'tools',
        'acme-release-tool',
        'current',
        'bin',
        commandFilename,
      ), 'utf8')).resolves.toBe('release-2');
    } finally {
      releasePromotion.resolve();
    }
  });
});

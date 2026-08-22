import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configurationState } = vi.hoisted(() => ({
  configurationState: {
    happyHomeDir: '',
  },
}));

const { downloadMock, extractMock, extractRootMock, platformState } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  extractMock: vi.fn(),
  extractRootMock: vi.fn(),
  platformState: {
    platform: 'linux' as NodeJS.Platform,
    arch: 'x64',
  },
}));

const { failingRenameTargets, concurrencyState } = vi.hoisted(() => ({
  failingRenameTargets: new Map<string, number>(),
  concurrencyState: {
    pauseFirstPromotion: false,
    onPromotionPaused: null as (() => void) | null,
    promotionRelease: null as Promise<void> | null,
    stagedCandidateCount: 0,
    onSecondCandidateStaged: null as (() => void) | null,
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (from.split(/[\\/]/).includes('extract') && /(?:^|[\\/])(?:next|candidate)$/.test(to)) {
        concurrencyState.stagedCandidateCount += 1;
        if (concurrencyState.stagedCandidateCount === 2) concurrencyState.onSecondCandidateStaged?.();
      }
      if (concurrencyState.pauseFirstPromotion && /(?:^|[\\/])current$/.test(to)) {
        concurrencyState.pauseFirstPromotion = false;
        concurrencyState.onPromotionPaused?.();
        await concurrencyState.promotionRelease;
      }
      const remainingFailures = failingRenameTargets.get(to) ?? 0;
      if (remainingFailures > 0) {
        if (remainingFailures === 1) {
          failingRenameTargets.delete(to);
        } else {
          failingRenameTargets.set(to, remainingFailures - 1);
        }
        const error = new Error(`EXDEV: mocked promotion failure, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
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
      return `${configurationState.happyHomeDir}/logs`;
    },
  },
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

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cft-test-'));
  tempDirs.add(dir);
  return dir;
}

function pinnedAsset(platform: 'linux-x64') {
  return {
    'linux-x64': {
      archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/linux64/chrome-linux64.zip',
      integrityDigest: `sha256:${'b'.repeat(64)}`,
      executableSubpath: 'chrome',
    },
  }[platform];
}

beforeEach(() => {
  vi.clearAllMocks();
  platformState.platform = 'linux';
  platformState.arch = 'x64';
});

afterEach(async () => {
  failingRenameTargets.clear();
  concurrencyState.pauseFirstPromotion = false;
  concurrencyState.onPromotionPaused = null;
  concurrencyState.promotionRelease = null;
  concurrencyState.stagedCandidateCount = 0;
  concurrencyState.onSecondCandidateStaged = null;
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  vi.resetModules();
});

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

describe('chromium-for-testing managed source adapter', () => {
  it('downloads the pinned archive digest-verified, unpacks, and promotes an executable into current', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./chromiumForTesting').catch(() => null);

    expect(mod?.installChromiumForTesting).toBeTypeOf('function');
    if (!mod?.installChromiumForTesting) return;

    const asset = pinnedAsset('linux-x64');

    // Simulate the downloader writing the archive bytes, and the extractor producing a payload root
    // that contains the chrome executable at the pinned subpath.
    downloadMock.mockImplementation(async (params: { destinationPath: string; digest?: string | null }) => {
      expect(params.digest).toBe(asset.integrityDigest);
      await writeFile(params.destinationPath, 'fake-archive-bytes');
    });
    extractRootMock.mockImplementation(async (params: { extractDir: string }) => {
      const payloadRoot = join(params.extractDir, 'chrome-linux64');
      const { mkdir, writeFile: write } = await import('node:fs/promises');
      await mkdir(payloadRoot, { recursive: true });
      await write(join(payloadRoot, 'chrome'), '#!/bin/sh\necho chrome');
      return payloadRoot;
    });

    const result = await mod.installChromiumForTesting({
      platform: 'linux',
      arch: 'x64',
      asset,
      pinnedVersion: '127.0.6533.88',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(access(result.executablePath, fsConstants.F_OK)).resolves.toBeUndefined();
    expect(result.executablePath.includes('current')).toBe(true);
  });

  it('keeps concurrent installs isolated until their serialized promotions commit', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./chromiumForTesting');
    const asset = pinnedAsset('linux-x64');
    const promotionPaused = deferred();
    const releasePromotion = deferred();
    const secondCandidateStaged = deferred();
    let extractedRelease = 0;

    downloadMock.mockImplementation(async (params: { destinationPath: string }) => {
      await writeFile(params.destinationPath, 'fake-archive-bytes');
    });
    extractRootMock.mockImplementation(async (params: { extractDir: string }) => {
      extractedRelease += 1;
      const payloadRoot = join(params.extractDir, `chrome-release-${extractedRelease}`);
      await mkdir(payloadRoot, { recursive: true });
      await writeFile(join(payloadRoot, 'chrome'), `release-${extractedRelease}`, 'utf8');
      return payloadRoot;
    });
    concurrencyState.pauseFirstPromotion = true;
    concurrencyState.onPromotionPaused = promotionPaused.resolve;
    concurrencyState.promotionRelease = releasePromotion.promise;
    concurrencyState.onSecondCandidateStaged = secondCandidateStaged.resolve;

    try {
      const firstPromise = mod.installChromiumForTesting({
        platform: 'linux',
        arch: 'x64',
        asset,
        pinnedVersion: '127.0.6533.88',
      });
      await promotionPaused.promise;
      const secondPromise = mod.installChromiumForTesting({
        platform: 'linux',
        arch: 'x64',
        asset,
        pinnedVersion: '127.0.6533.88',
      });
      await secondCandidateStaged.promise;
      releasePromotion.resolve();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      await expect(readFile(join(configurationState.happyHomeDir, 'tools', 'browser-chromium', 'current', 'chrome'), 'utf8'))
        .resolves.toBe('release-2');
    } finally {
      releasePromotion.resolve();
    }
  });

  it('fails closed when the pinned digest is missing (external-artifact remainder), writing no current', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./chromiumForTesting').catch(() => null);

    expect(mod?.installChromiumForTesting).toBeTypeOf('function');
    if (!mod?.installChromiumForTesting) return;

    const result = await mod.installChromiumForTesting({
      platform: 'linux',
      arch: 'x64',
      asset: {
        archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/127.0.6533.88/linux64/chrome-linux64.zip',
        integrityDigest: null,
        executableSubpath: 'chrome',
      },
      pinnedVersion: '127.0.6533.88',
    });

    expect(result.ok).toBe(false);
    expect(downloadMock).not.toHaveBeenCalled();
    const currentDir = join(configurationState.happyHomeDir, 'tools', 'browser-chromium', 'current');
    await expect(access(currentDir, fsConstants.F_OK)).rejects.toThrow();
  });

  it('fails closed when the downloaded archive digest does not match (no current promoted)', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./chromiumForTesting').catch(() => null);

    expect(mod?.installChromiumForTesting).toBeTypeOf('function');
    if (!mod?.installChromiumForTesting) return;

    // The download helper throws on checksum mismatch (mirrors downloadGitHubReleaseAsset).
    downloadMock.mockRejectedValue(new Error('[github-release] checksum verification failed'));

    const result = await mod.installChromiumForTesting({
      platform: 'linux',
      arch: 'x64',
      asset: pinnedAsset('linux-x64'),
      pinnedVersion: '127.0.6533.88',
    });

    expect(result.ok).toBe(false);
    const currentDir = join(configurationState.happyHomeDir, 'tools', 'browser-chromium', 'current');
    await expect(access(currentDir, fsConstants.F_OK)).rejects.toThrow();
  });

  it('keeps the existing current artifact when final promotion fails', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./chromiumForTesting').catch(() => null);

    expect(mod?.installChromiumForTesting).toBeTypeOf('function');
    if (!mod?.installChromiumForTesting) return;

    const asset = pinnedAsset('linux-x64');
    const currentDir = join(configurationState.happyHomeDir, 'tools', 'browser-chromium', 'current');
    await mkdir(currentDir, { recursive: true });
    await writeFile(join(currentDir, 'chrome'), 'old-current', 'utf8');
    failingRenameTargets.set(currentDir, 1);
    downloadMock.mockImplementation(async (params: { destinationPath: string }) => {
      await writeFile(params.destinationPath, 'fake-archive-bytes');
    });
    extractRootMock.mockImplementation(async (params: { extractDir: string }) => {
      const payloadRoot = join(params.extractDir, 'chrome-linux64');
      await mkdir(payloadRoot, { recursive: true });
      await writeFile(join(payloadRoot, 'chrome'), '#!/bin/sh\necho chrome');
      return payloadRoot;
    });

    const result = await mod.installChromiumForTesting({
      platform: 'linux',
      arch: 'x64',
      asset,
      pinnedVersion: '127.0.6533.88',
    });

    expect(result.ok).toBe(false);
    await expect(readFile(join(currentDir, 'chrome'), 'utf8')).resolves.toBe('old-current');
  });

  it('fails closed on an unsupported platform/arch pair', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./chromiumForTesting').catch(() => null);

    expect(mod?.installChromiumForTesting).toBeTypeOf('function');
    if (!mod?.installChromiumForTesting) return;

    const result = await mod.installChromiumForTesting({
      platform: 'freebsd',
      arch: 'x64',
      asset: pinnedAsset('linux-x64'),
      pinnedVersion: '127.0.6533.88',
    });

    expect(result.ok).toBe(false);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('resolves the managed executable path only after a current artifact exists', async () => {
    configurationState.happyHomeDir = await makeTempHome();
    const mod = await import('./chromiumForTesting').catch(() => null);

    expect(mod?.resolveInstalledChromiumForTestingExecutable).toBeTypeOf('function');
    if (!mod?.resolveInstalledChromiumForTestingExecutable) return;

    // No current dir yet -> null.
    await expect(mod.resolveInstalledChromiumForTestingExecutable({
      platform: 'linux',
      arch: 'x64',
      executableSubpath: 'chrome',
    })).resolves.toBeNull();
  });
});

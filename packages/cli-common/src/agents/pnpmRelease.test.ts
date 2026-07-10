import { describe, expect, it, vi } from 'vitest';

import { resolvePnpmReleaseAsset } from './pnpmRelease.js';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');

function withPlatformArch<T>(platform: NodeJS.Platform, arch: NodeJS.Architecture, callback: () => T): T {
  if (!originalPlatformDescriptor || !originalArchDescriptor) {
    throw new Error('Expected process platform and architecture to be configurable for this test');
  }
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
  Object.defineProperty(process, 'arch', { ...originalArchDescriptor, value: arch });
  try {
    return callback();
  } finally {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    Object.defineProperty(process, 'arch', originalArchDescriptor);
  }
}

function withGlibcRuntime<T>(callback: () => T): T {
  const getReport = vi.spyOn(process.report, 'getReport').mockReturnValue({
    header: { glibcVersionRuntime: '2.39' },
  } as unknown as NodeJS.ProcessReport);
  try {
    return callback();
  } finally {
    getReport.mockRestore();
  }
}

function isGlibcRuntime(): boolean {
  try {
    const report = process.report.getReport() as unknown as Readonly<{
      header?: Readonly<{ glibcVersionRuntime?: unknown }>;
    }>;
    const glibcVersionRuntime = report.header?.glibcVersionRuntime;
    return typeof glibcVersionRuntime === 'string' && glibcVersionRuntime.trim().length > 0;
  } catch {
    return false;
  }
}

function currentPnpmAssetName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'pnpm-darwin-arm64.tar.gz';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'pnpm-macos-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return isGlibcRuntime() ? 'pnpm-linux-arm64.tar.gz' : 'pnpm-linux-arm64-musl.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return isGlibcRuntime() ? 'pnpm-linux-x64.tar.gz' : 'pnpm-linux-x64-musl.tar.gz';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'pnpm-win32-arm64.zip';
  if (process.platform === 'win32' && process.arch === 'x64') return 'pnpm-win32-x64.zip';
  throw new Error(`Unsupported pnpm platform: ${process.platform}/${process.arch}`);
}

describe('resolvePnpmReleaseAsset', () => {
  it('selects the current Windows x64 archive asset', () => withPlatformArch('win32', 'x64', () => {
    expect(resolvePnpmReleaseAsset({
      tag_name: 'v11.8.0',
      assets: [
        {
          name: 'pnpm-win32-x64.zip',
          browser_download_url: 'https://example.com/pnpm-win32-x64.zip',
          digest: 'sha256:ce86f663be354800f24852675de14c5283a29e983c1be960f6c0159f5f71dc4a',
        },
      ],
    })).toMatchObject({
      name: 'pnpm-win32-x64.zip',
      url: 'https://example.com/pnpm-win32-x64.zip',
      digest: 'sha256:ce86f663be354800f24852675de14c5283a29e983c1be960f6c0159f5f71dc4a',
      version: '11.8.0',
    });
  }));

  it('prefers the current Linux glibc archive before musl archives on glibc runtimes', () => withPlatformArch('linux', 'x64', () => withGlibcRuntime(() => {
    expect(resolvePnpmReleaseAsset({
      tag_name: 'v11.8.0',
      assets: [
        {
          name: 'pnpm-linuxstatic-x64',
          browser_download_url: 'https://example.com/pnpm-linuxstatic-x64',
          digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        },
        {
          name: 'pnpm-linux-x64.tar.gz',
          browser_download_url: 'https://example.com/pnpm-linux-x64.tar.gz',
          digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        },
        {
          name: 'pnpm-linux-x64-musl.tar.gz',
          browser_download_url: 'https://example.com/pnpm-linux-x64-musl.tar.gz',
          digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        },
      ],
    }).name).toBe('pnpm-linux-x64.tar.gz');
  })));

  it('selects the current Darwin x64 archive asset when pnpm publishes the tarball variant', () => withPlatformArch('darwin', 'x64', () => {
    expect(resolvePnpmReleaseAsset({
      tag_name: 'v11.8.0',
      assets: [
        {
          name: 'pnpm-darwin-x64.tar.gz',
          browser_download_url: 'https://example.com/pnpm-darwin-x64.tar.gz',
          digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        },
      ],
    })).toMatchObject({
      name: 'pnpm-darwin-x64.tar.gz',
      url: 'https://example.com/pnpm-darwin-x64.tar.gz',
      digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      version: '11.8.0',
    });
  }));

  it('keeps selecting the legacy Darwin x64 standalone asset when present', () => withPlatformArch('darwin', 'x64', () => {
    expect(resolvePnpmReleaseAsset({
      tag_name: 'v10.6.5',
      assets: [
        {
          name: 'pnpm-macos-x64',
          browser_download_url: 'https://example.com/pnpm-macos-x64',
          digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        },
      ],
    }).name).toBe('pnpm-macos-x64');
  }));

  it('rejects a selected release asset when its digest is missing', () => {
    expect(() => resolvePnpmReleaseAsset({
      tag_name: 'v10.6.5',
      assets: [
        {
          name: currentPnpmAssetName(),
          browser_download_url: 'https://example.com/pnpm',
          digest: null,
        },
      ],
    })).toThrowError(`pnpm release asset ${currentPnpmAssetName()} is missing a required digest`);
  });

  it('rejects a selected release asset when its digest is blank', () => {
    expect(() => resolvePnpmReleaseAsset({
      tag_name: 'v10.6.5',
      assets: [
        {
          name: currentPnpmAssetName(),
          browser_download_url: 'https://example.com/pnpm',
          digest: '   ',
        },
      ],
    })).toThrowError(`pnpm release asset ${currentPnpmAssetName()} is missing a required digest`);
  });
});

import { describe, expect, it } from 'vitest';

import { resolvePnpmReleaseAsset } from './pnpmRelease.js';

function preferredPnpmAssetName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'pnpm-macos-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'pnpm-macos-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'pnpm-linuxstatic-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'pnpm-linuxstatic-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'pnpm-win-arm64.exe';
  if (process.platform === 'win32' && process.arch === 'x64') return 'pnpm-win-x64.exe';
  throw new Error(`Unsupported pnpm platform: ${process.platform}/${process.arch}`);
}

describe('resolvePnpmReleaseAsset', () => {
  it('rejects a selected release asset when its digest is missing', () => {
    expect(() => resolvePnpmReleaseAsset({
      tag_name: 'v10.6.5',
      assets: [
        {
          name: preferredPnpmAssetName(),
          browser_download_url: 'https://example.com/pnpm',
          digest: null,
        },
      ],
    })).toThrowError(`pnpm release asset ${preferredPnpmAssetName()} is missing a required digest`);
  });

  it('rejects a selected release asset when its digest is blank', () => {
    expect(() => resolvePnpmReleaseAsset({
      tag_name: 'v10.6.5',
      assets: [
        {
          name: preferredPnpmAssetName(),
          browser_download_url: 'https://example.com/pnpm',
          digest: '   ',
        },
      ],
    })).toThrowError(`pnpm release asset ${preferredPnpmAssetName()} is missing a required digest`);
  });
});

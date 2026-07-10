import { describe, expect, it } from 'vitest';

import {
  resolvePypiWheelAsset,
  type PypiWheelAssetSimpleIndex,
} from './resolve.js';
import { resolvePypiWheelAssetHostCompatibility } from './platform.js';
import type { PypiWheelAssetHostPlatform } from './types.js';

type ResolveParams = Parameters<typeof resolvePypiWheelAsset>[0] & Readonly<{
  linuxLibc?: 'glibc' | 'musl' | 'unknown';
}>;

const assetPathByPlatform = {
  'darwin-arm64': 'google/antigravity/bin/localharness',
  'linux-x64': 'google/antigravity/bin/localharness',
  'linux-arm64': 'google/antigravity/bin/localharness',
  'win32-x64': 'google/antigravity/bin/localharness.exe',
  'win32-arm64': 'google/antigravity/bin/localharness.exe',
} as const;

function wheelFile(filename: string, version: string, sha256: string, extra: Partial<PypiWheelAssetSimpleIndex['files'][number]> = {}) {
  return {
    filename,
    url: `https://files.pythonhosted.org/packages/${filename}`,
    hashes: { sha256 },
    requiresPython: '>=3.11',
    ...extra,
    coreMetadata: false,
    dataDistInfoMetadata: false,
    version,
  };
}

function fixtureIndex(): PypiWheelAssetSimpleIndex {
  return {
    meta: { apiVersion: '1.3' },
    name: 'google-antigravity',
    files: [
      wheelFile('google_antigravity-0.1.2-py3-none-macosx_14_0_arm64.whl', '0.1.2', 'a'.repeat(64)),
      wheelFile('google_antigravity-0.1.3-py3-none-macosx_14_0_arm64.whl', '0.1.3', 'b'.repeat(64), { yanked: 'bad release' }),
      wheelFile('google_antigravity-0.1.4-py3-none-macosx_14_0_arm64.whl', '0.1.4', 'c'.repeat(64)),
      wheelFile('google_antigravity-0.1.5-py3-none-macosx_14_0_x86_64.whl', '0.1.5', 'd'.repeat(64)),
      wheelFile('google_antigravity-0.1.5-py3-none-manylinux_2_17_x86_64.whl', '0.1.5', 'e'.repeat(64)),
      wheelFile('google_antigravity-0.1.5-py3-none-manylinux_2_17_aarch64.whl', '0.1.5', 'f'.repeat(64)),
      wheelFile('google_antigravity-0.1.6-py3-none-musllinux_1_2_x86_64.whl', '0.1.6', '3'.repeat(64)),
      wheelFile('google_antigravity-0.1.5-py3-none-win_amd64.whl', '0.1.5', '0'.repeat(64)),
      wheelFile('google_antigravity-0.1.5-py3-none-win_arm64.whl', '0.1.5', '1'.repeat(64)),
      wheelFile('google_antigravity-0.2.0-py3-none-macosx_14_0_arm64.whl', '0.2.0', '2'.repeat(64)),
    ],
  };
}

function resolve(params: ResolveParams) {
  return resolvePypiWheelAsset(params);
}

describe('resolvePypiWheelAsset', () => {
  it.each([
    ['darwin-arm64', undefined, 'google_antigravity-0.1.4-py3-none-macosx_14_0_arm64.whl', 'c'.repeat(64)],
    ['linux-x64', 'glibc', 'google_antigravity-0.1.5-py3-none-manylinux_2_17_x86_64.whl', 'e'.repeat(64)],
    ['linux-arm64', 'glibc', 'google_antigravity-0.1.5-py3-none-manylinux_2_17_aarch64.whl', 'f'.repeat(64)],
    ['win32-x64', undefined, 'google_antigravity-0.1.5-py3-none-win_amd64.whl', '0'.repeat(64)],
    ['win32-arm64', undefined, 'google_antigravity-0.1.5-py3-none-win_arm64.whl', '1'.repeat(64)],
  ] satisfies Array<[PypiWheelAssetHostPlatform, ResolveParams['linuxLibc'], string, string]>)(
    'selects the newest compatible non-yanked wheel for %s',
    async (platform, linuxLibc, filename, sha256) => {
      await expect(resolve({
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.3,<0.2.0',
        assetPathByPlatform,
        platform,
        ...(linuxLibc ? { linuxLibc } : {}),
        index: fixtureIndex(),
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        distribution: 'google-antigravity',
        version: filename.includes('0.1.4') ? '0.1.4' : '0.1.5',
        filename,
        sha256,
        assetPath: platform.startsWith('win32') ? 'google/antigravity/bin/localharness.exe' : 'google/antigravity/bin/localharness',
      }));
    },
  );

  it('selects musllinux wheels only for Linux musl hosts', async () => {
    await expect(resolve({
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      platform: 'linux-x64',
      linuxLibc: 'musl',
      index: fixtureIndex(),
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      filename: 'google_antigravity-0.1.6-py3-none-musllinux_1_2_x86_64.whl',
      sha256: '3'.repeat(64),
    }));
  });

  it('fails closed for macOS Intel instead of falling back to another architecture', async () => {
    await expect(resolve({
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      platform: 'darwin-x64',
      index: fixtureIndex(),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      code: 'unsupported_platform',
    }));
  });

  it('does not select manylinux wheels on Linux musl hosts', async () => {
    const index = fixtureIndex();
    await expect(resolve({
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      platform: 'linux-x64',
      linuxLibc: 'musl',
      index: {
        ...index,
        files: index.files.filter((file) => !file.filename.includes('musllinux')),
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      code: 'no_compatible_wheel',
    }));
  });

  it('does not select Linux wheels when libc compatibility cannot be proven', async () => {
    await expect(resolve({
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform,
      platform: 'linux-x64',
      linuxLibc: 'unknown',
      index: fixtureIndex(),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      code: 'unsupported_platform',
    }));
  });

  it('detects Linux musl as a supported host when a compatible musllinux wheel is available', () => {
    expect(resolvePypiWheelAssetHostCompatibility({
      platform: 'linux',
      arch: 'x64',
      linuxLibc: 'musl',
    })).toEqual({
      ok: true,
      platform: 'linux-x64',
      linuxLibc: 'musl',
    });
  });

  it('rejects unsupported PEP 440 specifier constructs instead of misparsing them', async () => {
    await expect(resolve({
      distribution: 'google-antigravity',
      versionSpecifier: '~=0.1.3',
      assetPathByPlatform,
      platform: 'darwin-arm64',
      index: fixtureIndex(),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      code: 'unsupported_version_specifier',
    }));
  });
});

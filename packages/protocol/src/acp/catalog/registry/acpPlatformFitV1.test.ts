import { describe, expect, it } from 'vitest';
import { resolveAcpPlatformFitV1, summarizeAcpRegistryDistributionV1 } from './acpPlatformFitV1.js';
import type { AcpBackendLaunchV1 } from '../settingsV1.js';

describe('resolveAcpPlatformFitV1', () => {
  const archive: AcpBackendLaunchV1 = { kind: 'archive', version: '1', args: [], assetsByPlatform: {
    'linux-x64': { archiveUrl: 'https://example.com/agent.tar.gz', executableSubpath: 'agent' },
  } };
  it('requires observed platform and architecture and an actual archive target', () => {
    expect(resolveAcpPlatformFitV1(archive, { platform: 'linux', arch: null })).toEqual({ kind: 'unknown', reason: 'arch_unknown' });
    expect(resolveAcpPlatformFitV1(archive, { platform: null, arch: 'x64' })).toEqual({ kind: 'unknown', reason: 'platform_unknown' });
    expect(resolveAcpPlatformFitV1(archive, { platform: 'windows', arch: 'aarch64' })).toEqual({ kind: 'cant_run', reason: 'no_build_for_platform' });
    expect(resolveAcpPlatformFitV1(archive, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'can_run', via: 'archive', target: 'linux-x64' });
  });
  it('rejects unsupported extraction and keeps raw executables runnable', () => {
    const asset = { archiveUrl: 'https://example.com/agent.rar', executableSubpath: 'agent' };
    expect(resolveAcpPlatformFitV1({ ...archive, assetsByPlatform: { 'linux-x64': asset } }, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'cant_run', reason: 'archive_type_unsupported' });
    expect(resolveAcpPlatformFitV1({ ...archive, assetsByPlatform: { 'linux-x64': { ...asset, kind: 'executable' } } }, { platform: 'linux', arch: 'x64' })).toMatchObject({ kind: 'can_run' });
  });
  it.each(['tar.bz2', 'tbz2'])('supports %s in mapped launches, registry previews and list summaries', (extension) => {
    const asset = { archiveUrl: `https://example.com/agent.${extension}`, executableSubpath: 'agent' };
    const distributions = { binary: { 'linux-x64': { archiveUrl: asset.archiveUrl, command: './agent', args: [], env: {} } } };
    const machine = { platform: 'linux', arch: 'x64' };
    const expected = { kind: 'can_run', via: 'archive', target: 'linux-x64' };
    expect(resolveAcpPlatformFitV1({ ...archive, assetsByPlatform: { 'linux-x64': asset } }, machine)).toEqual(expected);
    expect(resolveAcpPlatformFitV1(distributions, machine)).toEqual(expected);
    const summary = summarizeAcpRegistryDistributionV1(distributions);
    expect(summary).toEqual({ kind: 'archive', platforms: { 'linux-x64': 'supported' } });
    expect(resolveAcpPlatformFitV1(summary!, machine)).toEqual(expected);
  });
  it('admits managed uv on supported hosts without guessing missing platform facts', () => {
    for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
      expect(resolveAcpPlatformFitV1({ kind: 'uv', package: 'agent', version: '1', args: [] }, { platform, arch })).toEqual({ kind: 'can_run', via: 'uv' });
    }
    expect(resolveAcpPlatformFitV1({ kind: 'uv', package: 'agent', version: '1', args: [] }, { platform: 'linux', arch: null })).toEqual({ kind: 'unknown', reason: 'arch_unknown' });
  });
  it('uses the same distribution preference for registry previews as mapped launches', () => {
    expect(resolveAcpPlatformFitV1({ npm: { package: 'agent', version: '1.0.0', args: [], env: {} } }, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'can_run', via: 'npm' });
    expect(resolveAcpPlatformFitV1({ binary: { 'linux-x64': { archiveUrl: 'https://example.com/agent.tar.bz2', command: './agent', args: [], env: {} } } }, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'can_run', via: 'archive', target: 'linux-x64' });
  });
});

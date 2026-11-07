import { describe, expect, it } from 'vitest';

import { PluginManagedDependencyContributionV2Schema } from './managedDependencies.js';

describe('PluginManagedDependencyContributionV2Schema', () => {
  it('admits pinned managed JavaScript packages and refuses ranges, paths and undeclared executables', () => {
    const source = { kind: 'managedJavaScriptPackage', installId: 'dep.acme.json', packageName: '@acme/languages', version: '4.10.0' };
    const dependency = { id: 'json', title: 'JSON', executable: 'json-server', sources: [source] };
    expect(PluginManagedDependencyContributionV2Schema.parse(dependency)).toEqual(dependency);
    for (const patch of [{ version: '^4.10.0' }, { version: 'latest' }, { packageName: '../project' }, { packageName: 'https://example.test/code.tgz' }, { command: 'node' }]) {
      expect(PluginManagedDependencyContributionV2Schema.safeParse({ ...dependency, sources: [{ ...source, ...patch }] }).success).toBe(false);
    }
    expect(PluginManagedDependencyContributionV2Schema.safeParse({ ...dependency, executable: undefined }).success).toBe(false);
  });
  it('preserves optional pinned archive download size and rejects invalid byte counts', () => {
    const dependency = {
      id: 'acp-server', title: 'ACP server', executable: 'acp',
      sources: [{ kind: 'pinnedArchive', installId: 'dep.acp', version: '1', assetsByPlatform: {
        'linux-x64': { archiveUrl: 'https://example.test/acp.zip', sha256: 'a'.repeat(64), executableSubpath: 'acp', sizeBytes: 681969407 },
      } }],
    };
    const parsed = PluginManagedDependencyContributionV2Schema.safeParse(dependency);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(dependency);
    for (const sizeBytes of [-1, 1.5, Infinity]) {
      expect(PluginManagedDependencyContributionV2Schema.safeParse({ ...dependency, sources: [{
        ...dependency.sources[0], assetsByPlatform: { 'linux-x64': { ...dependency.sources[0].assetsByPlatform['linux-x64'], sizeBytes } },
      }] }).success).toBe(false);
    }
  });
  it('accepts a pinned direct archive with exact platform assets and rejects unsafe integrity or executable paths', () => {
    const dependency = {
      id: 'acp-server', title: 'ACP server', executable: 'agy_acp_server',
      sources: [{
        kind: 'pinnedArchive',
        installId: 'dep.antigravity.acp-server',
        version: '1.1.1',
        archiveExtractionLimits: {
          maxArchiveBytes: 1024 * 1024 * 1024,
          maxFileBytes: 2 * 1024 * 1024 * 1024,
          maxExpandedBytes: 2 * 1024 * 1024 * 1024,
          timeoutMs: 10 * 60_000,
        },
        assetsByPlatform: {
        'darwin-x64': {
          archiveUrl: 'https://dl.example.test/agy-acp-server-darwin-x86_64.zip', sha256: 'b'.repeat(64),
          executableSubpath: 'agy_acp_server.par',
        },
        'linux-x64': {
          archiveUrl: 'https://dl.example.test/agy-acp-server.zip', sha256: 'a'.repeat(64),
          executableSubpath: 'agy_acp_server.par', args: ['--uid='],
        },
      } }],
    };
    expect(PluginManagedDependencyContributionV2Schema.safeParse(dependency).success).toBe(true);
    expect(PluginManagedDependencyContributionV2Schema.safeParse({
      ...dependency,
      sources: [{ ...dependency.sources[0], assetsByPlatform: { 'linux-x64': {
        ...dependency.sources[0]!.assetsByPlatform['linux-x64'], sha256: 'not-a-digest',
      } } }],
    }).success).toBe(false);
    expect(PluginManagedDependencyContributionV2Schema.safeParse({
      ...dependency,
      sources: [{ ...dependency.sources[0], assetsByPlatform: { 'linux-x64': {
        ...dependency.sources[0]!.assetsByPlatform['linux-x64'], executableSubpath: '../agy_acp_server.par',
      } } }],
    }).success).toBe(false);
    expect(PluginManagedDependencyContributionV2Schema.safeParse({
      ...dependency,
      sources: [{ ...dependency.sources[0], archiveExtractionLimits: {
        ...dependency.sources[0]!.archiveExtractionLimits,
        maxFileBytes: dependency.sources[0]!.archiveExtractionLimits.maxExpandedBytes + 1,
      } }],
    }).success).toBe(false);
  });

  it.each([
    { kind: 'githubRelease', repository: 'acme/tool', assetPattern: 'tool-*' },
    { kind: 'npmArtifact', package: '@acme/tool', range: '^1' },
  ])('rejects unsupported executable source kind $kind at ingress', (source) => {
    expect(PluginManagedDependencyContributionV2Schema.safeParse({
      id: 'tool',
      title: 'Tool',
      executable: 'tool',
      sources: [source],
    }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import type { PluginAgentCliMetadata } from '../../plugins/contributions/agentCliMetadata.js';
import { PluginManagedDependencyContributionV2Schema } from '../../plugins/contributions/managedDependencies.js';
import { resolveAgentSetupInstall, resolveAgentSetupPlatform } from './agentSetup.js';

const cli: Pick<PluginAgentCliMetadata, 'install'> = {
  install: {
    managed: null,
    manual: { kind: 'vendor_recipe', recipes: {
      darwin: [{ cmd: 'bash', args: ['install.sh'] }],
      linux: [{ cmd: 'bash', args: ['install.sh'] }],
      win32: [{ cmd: 'powershell', args: ['install.ps1'] }],
    } },
    guideUrl: 'https://example.test/install',
  },
};
const asset = {
  archiveUrl: 'https://example.test/acp.zip', sha256: 'a'.repeat(64), executableSubpath: 'acp',
};
const dependency = PluginManagedDependencyContributionV2Schema.parse({
  id: 'acp', title: 'ACP', executable: 'acp',
  platforms: ['macos', 'linux', 'windows'], architectures: ['arm64', 'x64'],
  sources: [{ kind: 'pinnedArchive', installId: 'dep.acp', version: '1', assetsByPlatform: {
    'darwin-arm64': asset, 'linux-x64': asset, 'win32-x64': asset,
  } }],
});

describe('agent setup metadata', () => {
  it('requires the runtime dependency target even when the agent has a vendor recipe', () => {
    expect(resolveAgentSetupPlatform({ cli, dependencies: [dependency], platform: 'darwin', arch: 'x64' }))
      .toEqual({ supported: false, reason: 'arch' });
    expect(resolveAgentSetupInstall({ cli, dependencies: [dependency], platform: 'darwin', arch: 'x64' }))
      .toEqual({ available: false, mode: 'none', sizeBytes: null, guideUrl: 'https://example.test/install' });
  });

  it('supports Windows vendor recipes with an available required runtime', () => {
    const params = { cli, dependencies: [dependency], platform: 'win32', arch: 'x64' };
    expect(resolveAgentSetupPlatform(params)).toEqual({ supported: true });
    expect(resolveAgentSetupInstall(params)).toEqual({ available: true, mode: 'vendor_recipe', sizeBytes: null, guideUrl: 'https://example.test/install' });
  });

  it('keeps manually installed agents supported when no automated recipe exists', () => {
    const manualCli = { install: { manual: { kind: 'none' as const }, docsUrl: 'https://example.test/docs' } };
    const params = { cli: manualCli, platform: 'linux', arch: 'x64' };
    expect(resolveAgentSetupPlatform(params)).toEqual({ supported: true });
    expect(resolveAgentSetupInstall(params)).toEqual({ available: false, mode: 'manual', sizeBytes: null, guideUrl: 'https://example.test/docs' });
    expect(resolveAgentSetupInstall({ ...params, cli: null })).toEqual({ available: false, mode: 'none', sizeBytes: null, guideUrl: null });
    expect(resolveAgentSetupInstall({ ...params, cli: { install: { manual: { kind: 'command' } } } }))
      .toEqual({ available: false, mode: 'manual', sizeBytes: null, guideUrl: null });
  });

  it('supports runtime system executables but not manual dependency source declarations', () => {
    const alternate = { ...dependency, sources: [...dependency.sources, { kind: 'system' as const, executableNames: ['acp'] }] };
    expect(resolveAgentSetupPlatform({ cli, dependencies: [alternate], platform: 'darwin', arch: 'x64' }))
      .toEqual({ supported: true });
    const manual = { ...dependency, sources: [...dependency.sources, { kind: 'manual' as const, instructions: 'Install ACP manually' }] };
    expect(resolveAgentSetupPlatform({ cli, dependencies: [manual], platform: 'darwin', arch: 'x64' }))
      .toEqual({ supported: false, reason: 'arch' });
  });

  it('distinguishes recipe OS restrictions from managed release architecture restrictions', () => {
    const linuxCli = { install: { manual: { kind: 'vendor_recipe' as const, recipes: { linux: [{ cmd: 'sh', args: [] }] } } } };
    expect(resolveAgentSetupPlatform({ cli: linuxCli, platform: 'win32', arch: 'x64' })).toEqual({ supported: false, reason: 'os' });
    const managedCli = { install: { manual: { kind: 'none' as const }, managed: { kind: 'github_release_binary' as const, githubRepo: 'acme/agent', binaryName: 'agent' } } };
    expect(resolveAgentSetupPlatform({ cli: managedCli, platform: 'linux', arch: 'ia32' })).toEqual({ supported: false, reason: 'arch' });
    expect(resolveAgentSetupInstall({ cli: managedCli, platform: 'linux', arch: 'arm64' })).toEqual({ available: true, mode: 'managed', sizeBytes: null, guideUrl: null });
    expect(resolveAgentSetupPlatform({ cli, platform: 'freebsd', arch: 'x64' })).toEqual({ supported: false, reason: 'os' });
  });

  it('reports only known archive bytes for the selected target', () => {
    const sizedDependency = PluginManagedDependencyContributionV2Schema.parse({
      ...dependency,
      sources: [{ ...dependency.sources[0], assetsByPlatform: {
        'linux-x64': { ...asset, sizeBytes: 681969407 }, 'win32-x64': asset,
      } }],
    });
    expect(resolveAgentSetupInstall({ cli, dependencies: [sizedDependency], platform: 'linux', arch: 'x64' }).sizeBytes).toBe(681969407);
    expect(resolveAgentSetupInstall({ cli, dependencies: [sizedDependency], platform: 'win32', arch: 'x64' }).sizeBytes).toBeNull();
  });
});

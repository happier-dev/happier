import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol/installables/descriptor';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(async () => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function executable(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'fixture executable');
  await chmod(path, 0o755);
}

function fixtureDescriptor(legacyExecutables?: readonly Readonly<{
  relativePath: string;
  platforms?: readonly string[];
  requiresManagedJavaScriptRuntime?: boolean;
}>[]) {
  return InstallableDependencyDescriptorSchema.parse({
    id: 'fixture-runtime', key: 'fixture-runtime', kind: 'dep', version: '1',
    capabilityId: 'dep.fixture-runtime', display: { name: 'Fixture runtime' }, description: 'Fixture',
    source: { kind: 'github_release_binary', repo: 'fixture/runtime', assetNamePrefix: 'fixture',
      targetByPlatform: {
        'linux-x64-gnu': 'x86_64-linux', 'linux-x64-musl': 'x86_64-linux',
        'linux-arm64-gnu': 'aarch64-linux', 'linux-arm64-musl': 'aarch64-linux',
        'darwin-x64': 'x86_64-darwin', 'darwin-arm64': 'aarch64-darwin',
        'win32-x64': 'x86_64-windows', 'win32-arm64': 'aarch64-windows',
      }, launch: {
        kind: 'configured_binary', overrideEnvironmentKey: 'FIXTURE_BINARY',
        configOverridesEnvironmentKey: 'FIXTURE_CONFIG', configOverrideArgument: '--config',
        ...(legacyExecutables ? { legacyExecutables } : {}),
      } },
    binary: { commands: ['fixture-runtime'], systemFirst: true, managedFallback: true },
    defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
    consent: { install: 'required', update: 'required' },
  });
}

describe('configured binary through the release source adapter', () => {
  it('uses the selected dependency for status and override/system/managed precedence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-configured-binary-'));
    roots.push(home);
    const descriptor = fixtureDescriptor();
    const filename = process.platform === 'win32' ? 'fixture-runtime.exe' : 'fixture-runtime';
    const managed = join(home, 'tools', descriptor.key, 'current', 'bin', filename);
    const system = join(home, 'system', filename);
    const override = join(home, 'override', filename);
    await Promise.all([managed, system, override].map(executable));
    await writeFile(join(home, 'tools', descriptor.key, 'install-state.json'), JSON.stringify({
      installedVersion: '1.2.3', lastInstallLogPath: 'fixture-install.log',
    }));
    const env = { HAPPIER_HOME_DIR: home, PATH: dirname(system), FIXTURE_CONFIG: 'a=1\nb=2' };
    const { getGitHubReleaseBinaryRuntimeInstallableAdapter } = await import('./githubReleaseBinary');
    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor);
    expect(adapter).not.toBeNull();
    await expect(adapter?.detectCapabilityStatus?.({ env })).resolves.toMatchObject({
      installed: true, binPath: managed, installedVersion: '1.2.3', lastInstallLogPath: 'fixture-install.log',
    });
    await expect(adapter?.resolveLaunchCommand?.({ env })).resolves.toEqual({
      ok: true, command: 'fixture-runtime', args: ['--config', 'a=1', '--config', 'b=2'], source: 'system',
    });
    await expect(adapter?.resolveLaunchCommand?.({ env, sourcePreference: 'managed-first' })).resolves.toMatchObject({
      ok: true, command: managed, source: 'managed',
    });
    await expect(adapter?.resolveLaunchCommand?.({ env: { ...env, FIXTURE_BINARY: override } })).resolves.toMatchObject({
      ok: true, command: override, source: 'user_config',
    });
    await expect(adapter?.resolveLaunchCommand?.({ env: { ...env, FIXTURE_BINARY: join(home, 'missing') } })).resolves.toMatchObject({
      ok: false, canAutoInstall: false,
    });
    await rm(system);
    await expect(adapter?.resolveLaunchCommand?.({ env })).resolves.toMatchObject({ ok: true, command: managed, source: 'managed' });
    await rm(managed);
    await expect(adapter?.resolveLaunchCommand?.({ env })).resolves.toMatchObject({ ok: false, canAutoInstall: true });
    await expect(adapter?.detectLaunchResolution({ env })).resolves.toMatchObject({
      availability: { ok: false }, canAutoInstall: true, canBackgroundAutoUpdate: false,
    });
    await expect(adapter?.detectLaunchResolution({ env: { ...env, FIXTURE_BINARY: join(home, 'missing') } })).resolves.toMatchObject({
      availability: { ok: false }, canAutoInstall: false, canBackgroundAutoUpdate: false,
    });
  });

  it('honors a configured launch when optional release asset targeting is absent', async () => {
    const targetedDescriptor = fixtureDescriptor();
    if (targetedDescriptor.source.kind !== 'github_release_binary') throw new Error('Expected release source');
    const { assetNamePrefix: _prefix, targetByPlatform: _targets, ...source } = targetedDescriptor.source;
    const descriptor = InstallableDependencyDescriptorSchema.parse({ ...targetedDescriptor, source });
    const home = await mkdtemp(join(tmpdir(), 'happier-configured-binary-untargeted-'));
    roots.push(home);
    const override = join(home, 'override', process.platform === 'win32' ? 'fixture.exe' : 'fixture');
    await executable(override);
    const env = { HAPPIER_HOME_DIR: home, PATH: '', FIXTURE_BINARY: override, FIXTURE_CONFIG: 'a=1' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v2.0.0', assets: [{ name: `fixture-${process.platform}-${process.arch}.tar.gz`, browser_download_url: 'https://example.invalid/fixture.tar.gz' }],
    }), { status: 200 })));
    const { getGitHubReleaseBinaryRuntimeInstallableAdapter } = await import('./githubReleaseBinary');
    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor);
    await expect(adapter?.resolveLaunchCommand?.({ env })).resolves.toMatchObject({
      ok: true, command: override, args: ['--config', 'a=1'], source: 'user_config',
    });
    await expect(adapter?.detectCapabilityStatus?.({ env, includeLatestVersion: true })).resolves.toMatchObject({
      installed: false, latestVersionCheck: { ok: true, latestVersion: '2.0.0', label: 'v2.0.0' },
    });
  });

  it.each(['win32', 'linux', 'darwin'])('honors declared legacy candidate order and runtime prerequisite on %s', async platform => {
    if (!platformDescriptor) throw new Error('Expected configurable platform boundary');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    const home = await mkdtemp(join(tmpdir(), 'happier-configured-binary-legacy-'));
    roots.push(home);
    const descriptor = fixtureDescriptor([
      { relativePath: 'legacy/fixture.cmd', platforms: ['win32'], requiresManagedJavaScriptRuntime: true },
      { relativePath: 'legacy/fixture.exe', platforms: ['win32'], requiresManagedJavaScriptRuntime: true },
      { relativePath: 'legacy/fixture', requiresManagedJavaScriptRuntime: true },
    ]);
    const installDir = join(home, 'tools', descriptor.key);
    const candidates = ['fixture.cmd', 'fixture.exe', 'fixture'].map(name => join(installDir, 'legacy', name));
    await Promise.all(candidates.map(executable));
    const env = { HAPPIER_HOME_DIR: home, PATH: '' };
    const { getGitHubReleaseBinaryRuntimeInstallableAdapter } = await import('./githubReleaseBinary');
    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor);
    await expect(adapter?.detectCapabilityStatus?.({ env })).resolves.toMatchObject({ installed: false, binPath: null });
    const runtime = join(home, 'tools', 'js-runtime', 'current');
    await executable(join(runtime, 'bin', platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime'));
    await executable(platform === 'win32' ? join(runtime, 'runtime', 'node.exe') : join(runtime, 'runtime', 'bin', 'node'));
    const eligible = platform === 'win32' ? candidates : candidates.slice(2);
    for (const candidate of eligible) {
      await expect(adapter?.detectCapabilityStatus?.({ env })).resolves.toMatchObject({ installed: true, binPath: candidate });
      await expect(adapter?.resolveLaunchCommand?.({ env })).resolves.toMatchObject({ ok: true, command: candidate, source: 'managed' });
      await rm(candidate);
    }
    await expect(adapter?.detectCapabilityStatus?.({ env })).resolves.toMatchObject({ installed: false, binPath: null });
  });

  it('keeps host installation effects and updates only a newer selected managed release', async () => {
    const descriptor = fixtureDescriptor();
    const home = await mkdtemp(join(tmpdir(), 'happier-configured-binary-update-'));
    roots.push(home);
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('PATH', '');
    const filename = process.platform === 'win32' ? 'fixture-runtime.exe' : 'fixture-runtime';
    await executable(join(home, 'tools', descriptor.key, 'current', 'bin', filename));
    const statePath = join(home, 'tools', descriptor.key, 'install-state.json');
    await writeFile(statePath, JSON.stringify({ installedVersion: '1.0.0', lastInstallLogPath: null }));
    const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}`;
    // The external GitHub HTTP boundary returns a release; status and version comparison remain real.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v2.0.0', assets: [{ name: `fixture-2.0.0-${target}.tar.gz`, browser_download_url: 'https://example.invalid/fixture.tar.gz' }],
    }), { status: 200 })));
    const { createConfiguredBinaryRuntimeInstallableAdapter } = await import('./configuredBinary');
    const installOrUpgrade = vi.fn(async () => ({ ok: true as const, logPath: 'fixture-install.log' }));
    const adapter = createConfiguredBinaryRuntimeInstallableAdapter(descriptor, {
      key: descriptor.key, capabilityId: descriptor.capabilityId,
      detectLaunchResolution: async () => ({ availability: { ok: true }, canAutoInstall: false, canBackgroundAutoUpdate: true }),
      installOrUpgrade,
      runBackgroundAutoUpdateCheck: async () => {},
    });
    await adapter.runBackgroundAutoUpdateCheck?.();
    expect(installOrUpgrade).toHaveBeenCalledTimes(1);
    await writeFile(statePath, JSON.stringify({ installedVersion: '2.0.0', lastInstallLogPath: null }));
    await adapter.runBackgroundAutoUpdateCheck?.();
    expect(installOrUpgrade).toHaveBeenCalledTimes(1);
  });
});

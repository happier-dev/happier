import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import { createInstallableCapability } from '@/capabilities/deps/installables';
import { getArchiveDownloadInstallableAdapter, getRuntimeInstallableAdapter } from '../registry';

const { configurationState, downloadMock, extractMock } = vi.hoisted(() => ({
  configurationState: { happyHomeDir: '' },
  downloadMock: vi.fn(),
  extractMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() { return configurationState.happyHomeDir; },
    get logsDir() { return join(configurationState.happyHomeDir, 'logs'); },
  },
}));
vi.mock('@happier-dev/cli-common/agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/agents')>(),
  downloadGitHubReleaseAsset: downloadMock,
}));
vi.mock('@happier-dev/release-runtime/archiveExtraction', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/release-runtime/archiveExtraction')>(),
  extractArchivePayloadToDirectory: extractMock,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  configurationState.happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-desktop-test-'));
  downloadMock.mockImplementation(async (params: { destinationPath: string }) => {
    await writeFile(params.destinationPath, 'archive fixture');
  });
  // Download and archive extraction are external network/OS boundaries. Keep
  // the real registry, capability, installer, promotion and integrity readers.
  extractMock.mockImplementation(async (params: { extractDir: string }) => {
    await mkdir(params.extractDir, { recursive: true });
    for (const name of ['agent-desktop', 'agent-desktop.exe', 'agent-desktop-macos-helper', 'agent-desktop-linux-clipboard-owner', 'LICENSE']) {
      await writeFile(join(params.extractDir, name), `fixture ${name}`);
    }
  });
});

afterEach(async () => {
  await rm(configurationState.happyHomeDir, { recursive: true, force: true });
});

describe('managed Agent Desktop', () => {
  it('shares the admitted capability install with native launch and rejects a modified executable', async () => {
    const contribution = BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey['computer-agent-desktop'];
    expect(contribution).toBeDefined();
    if (!contribution) throw new Error('Agent Desktop contribution missing');
    expect(contribution?.descriptor.defaultPolicy).toEqual({ autoInstallWhenNeeded: false, autoUpdateMode: 'off' });
    expect(contribution?.descriptor.consent).toEqual({ install: 'required', update: 'required' });
    const runtime = await getRuntimeInstallableAdapter('computer-agent-desktop');
    const capability = createInstallableCapability(contribution.descriptor, runtime);
    const request = { id: 'dep.computer-agent-desktop' as const };
    await expect(capability?.detect({ request, context: { cliSnapshot: null } })).resolves.toMatchObject({ installed: false });
    expect(downloadMock).not.toHaveBeenCalled();

    await expect(capability?.invoke?.({ method: 'install' })).resolves.toEqual({ ok: true, result: { logPath: null } });
    const archive = getArchiveDownloadInstallableAdapter('computer-agent-desktop');
    expect(archive).not.toBeNull();
    const executableName = process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop';
    const current = join(configurationState.happyHomeDir, 'tools', 'computer-agent-desktop', 'current');
    const executable = join(current, executableName);
    await expect(archive?.resolveInstalledExecutable()).resolves.toBe(executable);
    await expect(runtime.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: true, command: executable, args: [], source: 'managed' });
    await expect(capability?.detect({ request, context: { cliSnapshot: null } })).resolves.toMatchObject({ installed: true, installedVersion: '1.0.2' });
    await expect(readFile(join(current, 'agent-desktop-macos-helper'), 'utf8')).resolves.toBe('fixture agent-desktop-macos-helper');
    await expect(readFile(join(current, 'agent-desktop-linux-clipboard-owner'), 'utf8')).resolves.toBe('fixture agent-desktop-linux-clipboard-owner');
    await expect(readFile(join(current, 'LICENSE'), 'utf8')).resolves.toBe('fixture LICENSE');

    await appendFile(executable, 'modified');
    await expect(archive?.resolveInstalledExecutable()).resolves.toBeNull();
    await expect(runtime.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: false });
    await expect(capability?.detect({ request, context: { cliSnapshot: null } })).resolves.toMatchObject({ installed: false });
  });

  // Pins from official v1.0.2 release API, independently verified against all
  // six downloaded native archives. Windows releases are tar.gz, not FFI zips.
  it.each([
    ['darwin', 'arm64', 'aarch64-apple-darwin', '7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19'],
    ['darwin', 'x64', 'x86_64-apple-darwin', '8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu', '864cb782e0afc8bf0df19622016b24bdbd1a83fc7749f784ee82aa49a7f845eb'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc', 'a0ecd6e17e60a0bcfbb45533a72f2d3a7a73508769588273ef08b0477d2b9687'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', '2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222'],
  ] as const)('installs the verified native %s/%s release', async (platform, arch, target, sha256) => {
    const adapter = getArchiveDownloadInstallableAdapter('computer-agent-desktop');
    expect(adapter).not.toBeNull();
    if (!adapter) throw new Error('Agent Desktop archive adapter missing');
    await expect(adapter.installOrUpgrade({ platform, arch })).resolves.toMatchObject({ ok: true, pinnedVersion: '1.0.2', integrityDigest: `sha256:${sha256}` });
    expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({
      url: `https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-${target}.tar.gz`,
      digest: `sha256:${sha256}`,
    }));
    await expect(adapter.resolveInstalledExecutable({ platform, arch })).resolves.toBe(join(configurationState.happyHomeDir, 'tools', 'computer-agent-desktop', 'current', platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop'));
  });

  it('refuses unsupported hosts without downloading', async () => {
    const adapter = getArchiveDownloadInstallableAdapter('computer-agent-desktop');
    expect(adapter).not.toBeNull();
    await expect(adapter?.resolveInstalledExecutable({ platform: 'linux', arch: 'riscv64' })).resolves.toBeNull();
    await expect(adapter?.installOrUpgrade({ platform: 'linux', arch: 'riscv64' })).resolves.toMatchObject({ ok: false });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('refuses an admitted descriptor without its required checksum', async () => {
    const { COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR, InstallableDependencyDescriptorSchema } = await import('@happier-dev/protocol/installables');
    const { getRuntimeInstallableAdapterForDescriptor } = await import('../registry');
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      ...COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR,
      source: { kind: 'pinned_archive', version: '1.0.2', assetsByPlatform: {
        [`${process.platform}-${process.arch}`]: { archiveUrl: 'https://example.test/native.tar.gz', executableSubpath: 'agent-desktop' },
      } },
    });
    await expect(getRuntimeInstallableAdapterForDescriptor(descriptor, { ownerId: 'happier.core' })).rejects.toThrow(/checksum/i);
    expect(downloadMock).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinnedArchiveRuntimeInstallableAdapter } from './pinnedArchive';
import { cancellationSources, createCancellationFixture } from './installCancellation.testkit';
import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol/installables';
import { ensureRuntimeInstallableDescriptorForLaunch } from '../ensureForLaunch';
import { getRuntimeInstallableAdapterForDescriptor } from '../registry';
import { getHappierTempRoot } from '@happier-dev/cli-common/tempDirs';
import { accountSettingsParse } from '@happier-dev/protocol';

const { configurationState } = vi.hoisted(() => ({ configurationState: { happyHomeDir: '' } }));
vi.mock('@/configuration', () => ({ configuration: configurationState }));

// Flat official-archive topology, with a tiny server executable and companion.
const archive = Buffer.from(
  'UEsDBBQAAAAAAKCqIl2/ze6ZDgAAAA4AAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyc2VydmVyLWZpeHR1cmVQSwMEFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxoYXJuZXNzLWZpeHR1cmVQSwECFAMUAAAAAACgqiJdv83umQ4AAAAOAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsBAhQDFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAAAAAAAAAAAAAO2BPgAAAGxvY2FsaGFybmVzc19leHRlcm5hbFBLBQYAAAAAAgACAIMAAACAAAAAAAA=',
  'base64',
);
const homes: string[] = [];
const servers: Server[] = [];

async function createFixture(slow = false, payload = archive) {
  const home = await mkdtemp(join(tmpdir(), 'happier-pinned-progress-'));
  homes.push(home);
  configurationState.happyHomeDir = home;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': payload.length });
    if (slow) response.write(payload.subarray(0, 8));
    else response.end(payload);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no port');
  const asset = {
    archiveUrl: `http://127.0.0.1:${address.port}/server.zip`,
    sha256: createHash('sha256').update(payload).digest('hex'),
    executableSubpath: 'agy_acp_server.par',
  };
  const adapter = createPinnedArchiveRuntimeInstallableAdapter({
    installId: 'dep.antigravity.agy-acp-server',
    version: '1.1.1',
    asset,
  });
  return { home, adapter, asset };
}

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  servers.length = 0;
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
  vi.resetModules();
});

describe('pinned archive acquisition progress and cancellation', () => {
  it('installs an unpublished-checksum archive and still detects executable tampering', async () => {
    const { home, asset } = await createFixture();
    const { sha256: _publishedChecksum, ...unpublishedAsset } = asset;
    const adapter = createPinnedArchiveRuntimeInstallableAdapter({ installId: 'dep.registry-agent', version: '1', asset: unpublishedAsset });
    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({ ok: true, checksum: 'not_published' });
    const command = join(home, 'tools', adapter.key, 'current', asset.executableSubpath);
    await expect(adapter.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: true, command });
    await appendFile(command, 'changed');
    await expect(adapter.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: false });
  });

  it('rejects a published checksum mismatch without promoting an install', async () => {
    const { home, asset } = await createFixture();
    const adapter = createPinnedArchiveRuntimeInstallableAdapter({ installId: 'dep.registry-agent', version: '1', asset: { ...asset, sha256: '0'.repeat(64) } });
    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({ ok: false, errorCode: 'verification-failed' });
    await expect(stat(join(home, 'tools', adapter.key, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs a raw executable into its declared nested path with checksum verification', async () => {
    const payload = Buffer.from('#!/bin/sh\necho registry-agent\n');
    const { home, asset } = await createFixture(false, payload);
    const adapter = createPinnedArchiveRuntimeInstallableAdapter({ installId: 'dep.registry-agent', version: '1', asset: {
      ...asset, archiveUrl: asset.archiveUrl.replace('/server.zip', '/candidate'), kind: 'executable', executableSubpath: 'bin/agent',
    } });
    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({ ok: true, checksum: 'verified' });
    const command = join(home, 'tools', adapter.key, 'current', 'bin', 'agent');
    await expect(readFile(command)).resolves.toEqual(payload);
    await expect(adapter.resolveLaunchCommand?.()).resolves.toMatchObject({ ok: true, command });
  });

  it.each([false, true])('ensures an Account descriptor through install, validation and launch (dedicated tools: %s)', async (dedicatedTools) => {
    const { home, asset } = await createFixture();
    const selectedHome = await mkdtemp(join(tmpdir(), 'happier-pinned-descriptor-'));
    homes.push(selectedHome);
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: 'registry-agent', key: 'registry-agent', kind: 'dep', version: '1', capabilityId: 'dep.registry-agent',
      display: { name: 'Registry agent' }, description: 'Admitted Account agent',
      source: { kind: 'pinned_archive', version: '1', assetsByPlatform: { [`${process.platform}-${process.arch}`]: {
        ...asset, archiveUrl: 'https://example.test/agent.zip',
      } } },
      binary: { commands: ['agent'], systemFirst: false, managedFallback: true },
      defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'off' },
      consent: { install: 'not_required', update: 'not_required' },
    });
    // The public schema requires HTTPS; transport uses the loopback HTTP fixture only.
    if (descriptor.source.kind !== 'pinned_archive') throw new Error('Expected archive descriptor');
    const platformAsset = descriptor.source.assetsByPlatform[`${process.platform as 'linux' | 'darwin' | 'win32'}-${process.arch as 'x64' | 'arm64'}`];
    if (!platformAsset) throw new Error('Expected current-platform fixture');
    platformAsset.archiveUrl = asset.archiveUrl;
    await expect(getRuntimeInstallableAdapterForDescriptor(descriptor, { ownerId: 'account-agent' }, {
      platform: 'linux', architecture: 's390x',
    })).rejects.toThrow('not executable');
    const installHome = join(selectedHome, 'public-payload');
    const toolsRoot = dedicatedTools ? join(installHome, 'tools') : join(selectedHome, 'tools');
    const env = { HAPPIER_HOME_DIR: selectedHome, ...(dedicatedTools ? { HAPPIER_FIRST_PARTY_INSTALL_HOME: installHome } : {}) };
    await expect(ensureRuntimeInstallableDescriptorForLaunch({
      descriptor, settings: accountSettingsParse({}), machineId: 'machine-1', env,
      managedAcpDefinition: { definitionId: 'definition-1', title: 'Registry agent' },
    })).resolves.toEqual({
      ok: true, installedKeys: ['registry-agent'],
    });
    expect(JSON.parse(await readFile(join(toolsRoot, descriptor.capabilityId, 'current', '.happier-managed-version'), 'utf8'))).toEqual({
      version: '1', definitionId: 'definition-1', title: 'Registry agent', kind: 'archive',
    });
    const adapter = await getRuntimeInstallableAdapterForDescriptor(descriptor, { ownerId: 'account-agent' });
    await expect(adapter.resolveLaunchCommand?.({ env })).resolves.toMatchObject({ ok: true, command: join(toolsRoot, descriptor.capabilityId, 'current', asset.executableSubpath) });
    if (dedicatedTools) await expect(stat(join(selectedHome, 'tools'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(home, 'tools'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(cancellationSources)('preserves a pre-aborted signal reason for $kind', async (source) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-install-cancel-'));
    homes.push(home);
    configurationState.happyHomeDir = home;
    const { descriptor, adapter } = await createCancellationFixture(source);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.installOrUpgrade({ env: { HAPPIER_HOME_DIR: home }, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    await expect(stat(join(home, 'tools', descriptor.key, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports actual downloaded bytes and publishes the verified archive', async () => {
    const { home, adapter } = await createFixture();
    const events: Array<{ t: string; bytesDone?: number; bytesTotal?: number | null }> = [];
    await expect(adapter.installOrUpgrade({ onProgress: (event) => events.push(event) })).resolves.toEqual({ ok: true, logPath: null, checksum: 'verified' });
    expect(events).toContainEqual({ t: 'progress', bytesDone: archive.length, bytesTotal: archive.length });
    await expect(readFile(join(home, 'tools', adapter.key, 'current', 'agy_acp_server.par'), 'utf8')).resolves.toBe('server-fixture');
    expect(await readdir(getHappierTempRoot(join(home, 'tools', adapter.key, '.tmp')))).toEqual([]);
  });

  it('installs and resolves from an explicitly selected environment home', async () => {
    const { home, adapter } = await createFixture();
    const selectedHome = await mkdtemp(join(tmpdir(), 'happier-pinned-selected-'));
    homes.push(selectedHome);
    const env = { HAPPIER_HOME_DIR: selectedHome };
    await expect(adapter.installOrUpgrade({ env })).resolves.toEqual({ ok: true, logPath: null, checksum: 'verified' });
    await expect(readFile(join(selectedHome, 'tools', adapter.key, 'current', 'agy_acp_server.par'), 'utf8')).resolves.toBe('server-fixture');
    await expect(adapter.resolveLaunchCommand?.({ env })).resolves.toMatchObject({ ok: true, command: join(selectedHome, 'tools', adapter.key, 'current', 'agy_acp_server.par') });
    await expect(adapter.detectLaunchResolution({ env })).resolves.toMatchObject({ availability: { ok: true } });
    await expect(stat(join(home, 'tools'))).rejects.toMatchObject({ code: 'ENOENT' });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.removeManagedInstall?.({ env, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    await expect(adapter.detectLaunchResolution({ env })).resolves.toMatchObject({ availability: { ok: true } });
    await adapter.removeManagedInstall?.({ env });
    await expect(stat(join(selectedHome, 'tools', adapter.key))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts an active download and removes its partial candidate', async () => {
    const { home, adapter } = await createFixture(true);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const installation = adapter.installOrUpgrade({
      signal: controller.signal,
      onProgress: (event) => {
        if (event.t === 'progress' && event.bytesDone > 0) controller.abort(reason);
      },
    });
    await expect(installation).rejects.toBe(reason);
    expect(controller.signal.aborted).toBe(true);
    expect(await readdir(getHappierTempRoot(join(home, 'tools', adapter.key, '.tmp')))).toEqual([]);
    await expect(stat(join(home, 'tools', adapter.key, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports the canonical extraction timeout code and removes its candidate', async () => {
    const { home, asset } = await createFixture();
    const adapter = createPinnedArchiveRuntimeInstallableAdapter({
      installId: 'dep.antigravity.agy-acp-server',
      version: '1.1.1',
      asset,
      archiveExtractionLimits: { timeoutMs: 0 },
    });
    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({ ok: false, errorCode: 'command-timed-out' });
    expect(await readdir(getHappierTempRoot(join(home, 'tools', adapter.key, '.tmp')))).toEqual([]);
    await expect(stat(join(home, 'tools', adapter.key, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the previous installed version when verification is cancelled', async () => {
    const { home, adapter, asset } = await createFixture();
    await expect(adapter.installOrUpgrade()).resolves.toMatchObject({ ok: true });
    const next = createPinnedArchiveRuntimeInstallableAdapter({ installId: 'dep.antigravity.agy-acp-server', version: '1.1.2', asset });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    await expect(next.installOrUpgrade({
      signal: controller.signal,
      onProgress: (event) => {
        if (event.t === 'log' && event.line === 'Verifying executable') controller.abort(reason);
      },
    })).rejects.toBe(reason);
    await expect(readFile(join(home, 'tools', adapter.key, 'current', '.happier-managed-version'), 'utf8')).resolves.toBe('1.1.1');
    expect(await readdir(getHappierTempRoot(join(home, 'tools', adapter.key, '.tmp')))).toEqual([]);
  });
});

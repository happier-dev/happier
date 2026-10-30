import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installVersionedPayload,
  readInstalledVersionMarkers,
  readLastCliUpdateResult,
  resolveDefaultManagedReleaseChannelStatePath,
  resolveFirstPartyInstallLayout,
  runManagedCliUpdate,
  watchLastCliUpdateResult,
} from './index.js';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
if (!originalPlatformDescriptor) throw new Error('process.platform descriptor is required for this test');
const platformDescriptor: PropertyDescriptor = originalPlatformDescriptor;

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
}

function binaryName(): string {
  return process.platform === 'win32' ? 'happier.exe' : 'happier';
}

async function createPayload(rootDir: string, versionId: string): Promise<string> {
  const payloadRoot = join(rootDir, `payload-${versionId}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
  await writeFile(join(payloadRoot, binaryName()), `binary-${versionId}`, 'utf8');
  await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
  return payloadRoot;
}

/** The staged binary "prints" the version its fixture content names — what a real `--version` does. */
async function readFixtureVersion(command: string): Promise<string | null> {
  const content = await readFile(command, 'utf8').catch(() => null);
  return content?.startsWith('binary-') ? content.slice('binary-'.length) : null;
}

describe('runManagedCliUpdate — the one CLI update transaction', () => {
  let homeDir = '';
  let env: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-update-tx-'));
    env = { ...process.env, HAPPIER_HOME_DIR: homeDir };
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  async function installInitial(versionId: string): Promise<void> {
    await installVersionedPayload({
      componentId: 'happier-cli', versionId, processEnv: env, payloadRoot: await createPayload(homeDir, versionId),
    });
  }

  function prepareFrom(versionId: string, options: Readonly<{ smokeReports?: string }> = {}) {
    return async () => {
      const payloadRoot = await createPayload(homeDir, versionId);
      if (options.smokeReports) {
        await writeFile(join(payloadRoot, binaryName()), `binary-${options.smokeReports}`, 'utf8');
      }
      return { versionId, payloadRoot, cleanup: async () => { await rm(payloadRoot, { recursive: true, force: true }); } };
    };
  }

  it('updates the shared installation without placing payloads or activation state in the private home', async () => {
    const installHome = join(homeDir, 'installation');
    const privateHome = join(homeDir, 'private');
    env = { ...env, HAPPIER_HOME_DIR: privateHome, HAPPIER_FIRST_PARTY_INSTALL_HOME: installHome };
    await installInitial('1.0.0');

    expect(await readFile(join(installHome, 'bin', binaryName()), 'utf8')).toBe('binary-1.0.0');
    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: prepareFrom('2.0.0'),
      readVersion: readFixtureVersion,
      restartServiceDaemon: async () => {
        expect(existsSync(join(installHome, 'first-party-activation.lock'))).toBe(true);
        expect(await readFile(join(installHome, 'bin', binaryName()), 'utf8')).toBe('binary-2.0.0');
      },
    });

    expect(result.outcome).toBe('succeeded');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: '2.0.0', previousVersionId: '1.0.0' });
    expect(resolveDefaultManagedReleaseChannelStatePath({ processEnv: env })).toBe(join(installHome, 'default-cli-release-channel.json'));
    expect(existsSync(privateHome)).toBe(false);
  });

  it('activates nothing when the staged executable does not report the target version', async () => {
    await installInitial('1.0.0');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    const restarts: string[] = [];

    await expect(runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: prepareFrom('2.0.0', { smokeReports: '1.9.9' }),
      readVersion: readFixtureVersion,
      restartServiceDaemon: async ({ expectedVersion }) => { restarts.push(expectedVersion); },
    })).rejects.toMatchObject({ code: 'cli_update_smoke_failed' });

    expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: '1.0.0', previousVersionId: null });
    expect(await readdir(layout.versionsDir)).toEqual(['1.0.0']);
    expect(await readFile(join(layout.shimDir, binaryName()), 'utf8')).toBe('binary-1.0.0');
    expect(restarts).toEqual([]);
    expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ targetVersion: '2.0.0', outcome: 'failed' });
  });

  it('keeps the recovery version during the restart, then commits and prunes', async () => {
    await installInitial('0.9.0');
    await installInitial('1.0.0');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    const observedDuringRestart: string[][] = [];

    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: prepareFrom('2.0.0'),
      readVersion: readFixtureVersion,
      restartServiceDaemon: async ({ expectedVersion, phase }) => {
        expect(phase).toBe('activated');
        expect(expectedVersion).toBe('2.0.0');
        expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ outcome: 'pendingReconnect', targetVersion: '2.0.0' });
        observedDuringRestart.push((await readdir(layout.versionsDir)).sort());
      },
    });

    expect(result).toMatchObject({ outcome: 'succeeded', previousVersion: '1.0.0', targetVersion: '2.0.0', restarted: true });
    expect(observedDuringRestart).toEqual([['0.9.0', '1.0.0', '2.0.0']]);
    expect((await readdir(layout.versionsDir)).sort()).toEqual(['1.0.0', '2.0.0']);
    expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: '2.0.0', previousVersionId: '1.0.0' });
    expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ outcome: 'succeeded', targetVersion: '2.0.0' });
    expect(existsSync(`${layout.installRoot}.mutation.lock`)).toBe(false);
    expect(existsSync(join(homeDir, 'first-party-activation.lock'))).toBe(false);
  });

  for (const platform of ['linux', 'win32'] as const) {
    it(`restores every piece of activation state and restarts the previous binary when the restart is not proven (${platform})`, async () => {
      await withPlatform(platform, async () => {
        await installInitial('1.0.0');
        const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
        const defaultChannelPath = resolveDefaultManagedReleaseChannelStatePath({ processEnv: env });
        const defaultChannelBefore = await readFile(defaultChannelPath, 'utf8');
        const restarts: Array<Readonly<{ phase: string; expectedVersion: string; shim: string }>> = [];

        const result = await runManagedCliUpdate({
          channel: 'stable',
          processEnv: env,
          preparePayload: prepareFrom('2.0.0'),
          readVersion: readFixtureVersion,
          restartServiceDaemon: async ({ phase, expectedVersion }) => {
            restarts.push({ phase, expectedVersion, shim: await readFile(join(layout.shimDir, binaryName()), 'utf8') });
            if (phase === 'activated') throw new Error('the new daemon never became the owner');
          },
        });

        expect(result).toMatchObject({ outcome: 'rolledBack', previousVersion: '1.0.0', targetVersion: '2.0.0' });
        expect(restarts).toEqual([
          { phase: 'activated', expectedVersion: '2.0.0', shim: 'binary-2.0.0' },
          { phase: 'restored', expectedVersion: '1.0.0', shim: 'binary-1.0.0' },
        ]);
        expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: '1.0.0', previousVersionId: null });
        expect(await readFile(join(layout.currentPath, binaryName()), 'utf8')).toBe('binary-1.0.0');
        expect(await readFile(join(layout.shimDir, binaryName()), 'utf8')).toBe('binary-1.0.0');
        expect(await readFile(defaultChannelPath, 'utf8')).toBe(defaultChannelBefore);
        expect(existsSync(layout.previousPath)).toBe(false);
        expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({
          outcome: 'rolledBack',
          targetVersion: '2.0.0',
          message: expect.stringContaining('the new daemon never became the owner'),
        });
        expect(existsSync(`${layout.installRoot}.mutation.lock`)).toBe(false);
    expect(existsSync(join(homeDir, 'first-party-activation.lock'))).toBe(false);
      });
    });
  }

  it('reclaims an install lock its holder abandoned (stale by the lock owner\'s rule)', async () => {
    await installInitial('1.0.0');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    // A crashed holder's proper-lockfile directory, untouched for longer than the owner's stale window.
    const lockPath = `${layout.installRoot}.mutation.lock`;
    await mkdir(lockPath, { recursive: true });
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(lockPath, longAgo, longAgo);
    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: prepareFrom('2.0.0'),
      readVersion: readFixtureVersion,
      restartServiceDaemon: null,
    });
    expect(result).toMatchObject({ outcome: 'succeeded', restarted: false });
  });

  it('records a failure before activation (release, download, unpack) and changes nothing', async () => {
    await installInitial('1.0.0');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    await expect(runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: async () => { throw new Error('GitHub returned 503'); },
      readVersion: readFixtureVersion,
      restartServiceDaemon: async () => { throw new Error('must not restart'); },
    })).rejects.toThrow('GitHub returned 503');
    expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({
      targetVersion: null,
      outcome: 'failed',
      message: expect.stringContaining('GitHub returned 503'),
    });
    expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: '1.0.0', previousVersionId: null });

    await expect(runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      targetVersion: '1.2.0',
      preparePayload: async () => { throw new Error('checksum signature mismatch'); },
      readVersion: readFixtureVersion,
      restartServiceDaemon: null,
    })).rejects.toThrow('checksum signature mismatch');
    expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ targetVersion: '1.2.0', outcome: 'failed' });
  });

  it('never lets another channel\'s update touch this update\'s recovery launchers', async () => {
    await installInitial('1.0.0');
    await installVersionedPayload({
      componentId: 'happier-cli', channel: 'preview', versionId: '1.0.0-preview.1', processEnv: env,
      payloadRoot: await createPayload(homeDir, '1.0.0-preview.1'),
    });
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    const previewShim = join(layout.shimDir, process.platform === 'win32' ? 'hprev.exe' : 'hprev');
    let previewUpdate: Promise<unknown> | null = null;
    let previewShimWhileStableRestarts: string | null = null;

    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: prepareFrom('2.0.0'),
      readVersion: readFixtureVersion,
      restartServiceDaemon: async ({ phase }) => {
        if (phase !== 'activated') return;
        // A preview update starts while this one waits for the stable service. It shares the
        // launchers in <home>/bin, so it must wait for the home-wide activation lock.
        previewUpdate = runManagedCliUpdate({
          channel: 'preview',
          processEnv: env,
          preparePayload: prepareFrom('1.1.0-preview.1'),
          readVersion: readFixtureVersion,
          restartServiceDaemon: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        previewShimWhileStableRestarts = await readFile(previewShim, 'utf8');
        throw new Error('the stable service did not come back');
      },
    });

    expect(result).toMatchObject({ outcome: 'rolledBack', previousVersion: '1.0.0' });
    expect(previewShimWhileStableRestarts).toBe('binary-1.0.0-preview.1');
    expect(await readFile(join(layout.shimDir, binaryName()), 'utf8')).toBe('binary-1.0.0');
    await expect(previewUpdate).resolves.toMatchObject({ outcome: 'succeeded', targetVersion: '1.1.0-preview.1' });
    expect(await readFile(previewShim, 'utf8')).toBe('binary-1.1.0-preview.1');
    expect(await readFile(join(layout.shimDir, binaryName()), 'utf8')).toBe('binary-1.0.0');
    expect(existsSync(join(layout.shimDir, '.update-rollback')) ? await readdir(join(layout.shimDir, '.update-rollback')) : []).toEqual([]);
  });

  it('recovers first and records the outcome only after the previous version is proven, even when records cannot be written', async () => {
    await installInitial('1.0.0');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    // `last-update.json` cannot be replaced: every record write fails.
    await mkdir(join(layout.installRoot, 'last-update.json'), { recursive: true });
    const restarts: string[] = [];
    const recordFailures: string[] = [];

    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: prepareFrom('2.0.0'),
      readVersion: readFixtureVersion,
      onRecordFailure: (error) => { recordFailures.push(String(error)); },
      restartServiceDaemon: async ({ phase, expectedVersion }) => {
        restarts.push(`${phase}:${expectedVersion}`);
        if (phase === 'activated') throw new Error('new daemon crashed');
      },
    });

    expect(restarts).toEqual(['activated:2.0.0', 'restored:1.0.0']);
    expect(result).toMatchObject({ outcome: 'rolledBack', previousVersion: '1.0.0' });
    expect(await readFile(join(layout.shimDir, binaryName()), 'utf8')).toBe('binary-1.0.0');
    expect(recordFailures.length).toBeGreaterThan(0);
  });

  it('records rolledBack only after the restored daemon is proven, and failed when it is not', async () => {
    await installInitial('1.0.0');
    const seenDuringRestoredRestart: Array<string | null> = [];

    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: prepareFrom('2.0.0'),
      readVersion: readFixtureVersion,
      restartServiceDaemon: async ({ phase }) => {
        if (phase === 'restored') {
          seenDuringRestoredRestart.push(readLastCliUpdateResult({ channel: 'stable', processEnv: env })?.outcome ?? null);
          throw new Error('the restored daemon did not come back either');
        }
        throw new Error('new daemon crashed');
      },
    });

    expect(seenDuringRestoredRestart).toEqual(['pendingReconnect']);
    expect(result).toMatchObject({
      outcome: 'failed',
      targetVersion: '2.0.0',
      message: expect.stringMatching(/1\.0\.0 was restored.*did not come back either/),
    });
    expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ outcome: 'failed' });
  });

  it('tells a watcher (the running daemon) whenever an attempt records its end', async () => {
    await installInitial('1.0.0');
    let notified: () => void = () => {};
    const changed = new Promise<void>((resolve) => { notified = resolve; });
    const stop = watchLastCliUpdateResult({ channel: 'stable', processEnv: env, onChange: () => notified() });
    expect(stop).not.toBeNull();
    try {
      await runManagedCliUpdate({
        channel: 'stable',
        processEnv: env,
        preparePayload: async () => { throw new Error('offline'); },
        readVersion: readFixtureVersion,
        restartServiceDaemon: null,
      }).catch(() => undefined);
      await changed;
    } finally {
      stop?.();
    }
    expect(watchLastCliUpdateResult({ channel: 'preview', processEnv: env, onChange: () => {} })).toBeNull();
  });

  it('admits an attempt (both locks held) before it downloads anything', async () => {
    await installInitial('1.0.0');
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    const order: string[] = [];
    await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      onAdmitted: () => {
        order.push(`admitted:${existsSync(`${layout.installRoot}.mutation.lock`)}:${existsSync(join(homeDir, 'first-party-activation.lock'))}`);
      },
      preparePayload: async () => { order.push('download'); throw new Error('offline'); },
      readVersion: readFixtureVersion,
      restartServiceDaemon: null,
    }).catch(() => undefined);
    expect(order).toEqual(['admitted:true:true', 'download']);
  });
});


import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Real file system; removing the pruned `versions/0.9.0` fails with a non-retryable EIO. */
const fault = vi.hoisted(() => ({ failPrunePathPart: '', failLockRelease: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      const target = String(args[0]).replace(/\\/g, '/');
      if (fault.failLockRelease && /\/cli\.mutation\.lock$/u.test(target)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked, rm'), { code: 'EBUSY' });
      }
      if (fault.failPrunePathPart && target.endsWith(fault.failPrunePathPart)) {
        throw Object.assign(new Error('EIO: i/o error, rm'), { code: 'EIO' });
      }
      return await actual.rm(...args);
    }),
  };
});

import { installVersionedPayload, readInstalledVersionMarkers, readLastCliUpdateResult, resolveFirstPartyInstallLayout, runManagedCliUpdate } from './index.js';

async function createPayload(rootDir: string, versionId: string): Promise<string> {
  const payloadRoot = join(rootDir, `payload-${versionId}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
  await writeFile(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), `binary-${versionId}`, 'utf8');
  await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
  return payloadRoot;
}

describe('runManagedCliUpdate after commit', () => {
  let homeDir = '';
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-update-prune-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    fault.failPrunePathPart = '';
    fault.failLockRelease = false;
    await rm(homeDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32').each(['install', 'update'] as const)('warns without failing %s when lsof is unavailable, and retains uncertain versions', async (operation) => {
    const tools = join(homeDir, 'tools');
    await mkdir(tools);
    // Native observation is the boundary: no active argv match, unavailable lsof.
    await writeFile(join(tools, 'ps'), '#!/bin/sh\nprintf fixture-process\n', { mode: 0o755 });
    await writeFile(join(tools, 'lsof'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${tools}:${process.env.PATH}`);
    const env = { HAPPIER_HOME_DIR: homeDir };
    for (const versionId of ['0.9.0', '1.0.0']) {
      await installVersionedPayload({ componentId: 'happier-cli', versionId, processEnv: env, payloadRoot: await createPayload(homeDir, versionId) });
    }
    const warnings: string[] = [];
    if (operation === 'install') {
      await installVersionedPayload({ componentId: 'happier-cli', versionId: '2.0.0', processEnv: env,
        payloadRoot: await createPayload(homeDir, '2.0.0'), onWarning: (message: string) => { warnings.push(message); } });
    } else {
      const result = await runManagedCliUpdate({ channel: 'stable', processEnv: env,
        preparePayload: async () => ({ versionId: '2.0.0', payloadRoot: await createPayload(homeDir, '2.0.0'), cleanup: async () => {} }),
        readVersion: async command => (await readFile(command, 'utf8')).replace('binary-', ''),
        restartServiceDaemon: null, onWarning: message => { warnings.push(message); } });
      expect(result.outcome).toBe('succeeded');
      expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ outcome: 'succeeded' });
    }
    expect(warnings).toEqual([expect.stringContaining('lsof')]);
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
    expect(await readInstalledVersionMarkers(layout)).toEqual({ currentVersionId: '2.0.0', previousVersionId: '1.0.0' });
    expect((await readdir(layout.versionsDir)).sort()).toEqual(['0.9.0', '1.0.0', '2.0.0']);
  });

  it('records a proven update as succeeded when pruning an old version fails, and reports the prune as a warning', async () => {
    const env = { HAPPIER_HOME_DIR: homeDir };
    for (const versionId of ['0.9.0', '1.0.0']) {
      await installVersionedPayload({ componentId: 'happier-cli', versionId, processEnv: env, payloadRoot: await createPayload(homeDir, versionId) });
    }
    fault.failPrunePathPart = 'versions/0.9.0';
    const warnings: string[] = [];

    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: async () => {
        const payloadRoot = await createPayload(homeDir, '2.0.0');
        return { versionId: '2.0.0', payloadRoot, cleanup: async () => {} };
      },
      readVersion: async (command) => (await readFile(command, 'utf8')).replace('binary-', ''),
      restartServiceDaemon: async () => {},
      onWarning: (message) => { warnings.push(message); },
    });

    expect(result).toMatchObject({ outcome: 'succeeded', targetVersion: '2.0.0', restarted: true });
    expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ outcome: 'succeeded', targetVersion: '2.0.0' });
    expect(await readInstalledVersionMarkers(resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env })))
      .toEqual({ currentVersionId: '2.0.0', previousVersionId: '1.0.0' });
    expect(warnings).toEqual([expect.stringContaining('EIO')]);
  });

  it('keeps a proven update succeeded when releasing the install lock fails, and reports the release as a diagnostic', async () => {
    const env = { HAPPIER_HOME_DIR: homeDir };
    await installVersionedPayload({ componentId: 'happier-cli', versionId: '1.0.0', processEnv: env, payloadRoot: await createPayload(homeDir, '1.0.0') });
    const warnings: string[] = [];

    const result = await runManagedCliUpdate({
      channel: 'stable',
      processEnv: env,
      preparePayload: async () => {
        // proper-lockfile releases its lock directory with rmdir; a stray entry makes that fail.
        await writeFile(join(homeDir, 'cli.mutation.lock', 'stray-entry'), '');
        const payloadRoot = await createPayload(homeDir, '2.0.0');
        return { versionId: '2.0.0', payloadRoot, cleanup: async () => {} };
      },
      readVersion: async (command) => (await readFile(command, 'utf8')).replace('binary-', ''),
      restartServiceDaemon: async () => {},
      onWarning: (message) => { warnings.push(message); },
    });

    expect(result).toMatchObject({ outcome: 'succeeded', targetVersion: '2.0.0' });
    expect(readLastCliUpdateResult({ channel: 'stable', processEnv: env })).toMatchObject({ outcome: 'succeeded' });
    expect(warnings).toEqual([expect.stringMatching(/lock.*could not be released/iu)]);
  });
});


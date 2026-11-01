import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as processBoundary from '@happier-dev/cli-common/process';
import { detectGhLaunchResolution } from '@/packagedRuntime/installables/ghRuntimeInstallable';

import { ghBinPath, getGhDepStatus, resolveGhNativeToken } from './gh';

afterEach(() => vi.restoreAllMocks());

describe('GitHub capability idle cost', () => {
  it('keeps repeated refreshes offline while sign-in changes and action refusals remain observable', async () => {
    let signedIn = true;
    const home = await mkdtemp(join(tmpdir(), 'gh-idle-'));
    const env = { HAPPIER_HOME_DIR: home, PATH: '' };
    const binPath = ghBinPath(env);
    await mkdir(dirname(binPath), { recursive: true });
    await writeFile(binPath, 'fixture');
    if (process.platform !== 'win32') await chmod(binPath, 0o755);
    // Keep selection, filesystem discovery, and launch wiring real beneath the OS boundary.
    const execute = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (_command, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.75.0', stderr: '' };
      if (!signedIn) throw Object.assign(new Error('not signed in'), { code: 1 });
      const token = String(1);
      return { stdout: token, stderr: '' };
    });
    try {
      for (let refresh = 0; refresh < 82; refresh++) {
        await expect(getGhDepStatus({ env })).resolves.toMatchObject({
          installed: true, authenticated: true, authStatus: 'authenticated',
        });
        await expect(detectGhLaunchResolution({ env })).resolves.toMatchObject({ availability: { ok: true } });
      }
      // Count network-capable subprocesses at the OS command boundary, not internal helper calls.
      expect(execute.mock.calls.filter(([, args]) => args[1] === 'status')).toHaveLength(0);

      signedIn = false;
      await expect(getGhDepStatus({ env })).resolves.toMatchObject({
        installed: true, authenticated: false, authStatus: 'missing_auth', remediationReason: 'auth_required',
      });
      // An actual credential request still provides the typed, actionable sign-in refusal.
      await expect(resolveGhNativeToken({ env })).resolves.toEqual({
        ok: false, reason: 'unavailable', remediation: 'sign in with gh CLI',
      });
      await expect(detectGhLaunchResolution({ env })).resolves.toMatchObject({ availability: { ok: false } });
      signedIn = true;
      await expect(getGhDepStatus({ env })).resolves.toMatchObject({ authenticated: true, remediationReason: null });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

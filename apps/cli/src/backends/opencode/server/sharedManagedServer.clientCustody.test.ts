import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { spawnDetachedInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createManagedOpenCodeClientFixture } from './managedOpenCodeClient.testkit';
import { isOpenCodeServerPidAlive } from './openCodeServerProcessState';
import {
  readSharedManagedOpenCodeServerStateByBaseUrlBestEffort,
  reapUnusedSharedManagedOpenCodeServersBestEffort,
  stopSharedManagedOpenCodeServerFromEnvBestEffort,
} from './sharedManagedServer';

afterEach(() => vi.restoreAllMocks());

describe('managed OpenCode client custody', () => {
  it('retains a legacy flat server during automatic daemon shutdown even when daemon ownership matches', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    try {
      const state = await fixture.publish();
      const legacyPath = join(dirname(dirname(fixture.statePath)), basename(fixture.statePath));
      await writeFile(legacyPath, JSON.stringify(state));
      await fixture.removeState();

      await stopSharedManagedOpenCodeServerFromEnvBestEffort({ daemonInstanceId: state.daemonInstanceId! });

      expect(isOpenCodeServerPidAlive(fixture.pid)).toBe(true);
      expect(await readFile(legacyPath, 'utf8')).toBe(JSON.stringify(state));
    } finally {
      await fixture.close();
    }
  });

  it.each(['dead', 'reused'] as const)('prunes a %s client process record before reclaiming its unused server', async (kind) => {
    const fixture = await createManagedOpenCodeClientFixture();
    const clientProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)');
    const clientPid = clientProcess.pid;
    if (!clientPid) throw new Error('Client process did not start');
    try {
      const birth = readProcessInstanceFingerprintSync(clientPid);
      if (!birth) throw new Error('Client process identity unavailable');
      const claimDirectory = `${fixture.statePath}.clients`;
      await mkdir(claimDirectory, { recursive: true });
      const claimPath = join(claimDirectory, 'departed.json');
      await writeFile(claimPath, JSON.stringify({
        pid: clientPid,
        processInstanceFingerprint: kind === 'reused' ? `${birth}-prior-instance` : birth,
      }));
      if (kind === 'dead') {
        process.kill(clientPid, 'SIGKILL');
        expect(await waitForProcessExit(clientPid, { timeoutMs: 1_000 })).toBe(true);
      }

      await reapUnusedSharedManagedOpenCodeServersBestEffort();

      expect(existsSync(claimPath)).toBe(false);
      expect(await waitForProcessExit(fixture.pid, { timeoutMs: 1_000 })).toBe(true);
      expect(existsSync(fixture.statePath)).toBe(false);
      if (kind === 'reused') expect(isOpenCodeServerPidAlive(clientPid)).toBe(true);
    } finally {
      try { process.kill(clientPid, 'SIGKILL'); } catch {}
      await waitForProcessExit(clientPid, { timeoutMs: 1_000 });
      await fixture.close();
    }
  });

  it.each(['malformed', 'unreadable', 'missing birth'] as const)('retains its live server and state when a published client record is %s', async (kind) => {
    const fixture = await createManagedOpenCodeClientFixture();
    try {
      const claimDirectory = `${fixture.statePath}.clients`;
      await mkdir(claimDirectory, { recursive: true });
      const claimPath = join(claimDirectory, 'unknown.json');
      if (kind === 'unreadable') await mkdir(claimPath);
      else if (kind === 'missing birth') await writeFile(claimPath, JSON.stringify({ pid: process.pid, processInstanceFingerprint: null }));
      else await writeFile(claimPath, '{"pid":');
      const stateBefore = await readFile(fixture.statePath, 'utf8');

      await reapUnusedSharedManagedOpenCodeServersBestEffort();

      expect(isOpenCodeServerPidAlive(fixture.pid)).toBe(true);
      expect(await readFile(fixture.statePath, 'utf8')).toBe(stateBefore);
      expect(existsSync(claimPath)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('keeps custody on a pinned target when a stale ambient state shares its recycled endpoint', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    try {
      const targetFingerprint = 'b'.repeat(64);
      const state = await fixture.publish();
      const targetPath = join(dirname(fixture.statePath), `${targetFingerprint}.json`);
      await writeFile(targetPath, JSON.stringify({ ...state, launchEnvFingerprint: targetFingerprint, ownerToken: 'pinned-target' }));
      await fixture.publish({ pid: 99_999_999 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ healthy: true, version: 'fake-opencode' }));
      await fixture.createClient({
        directory: fixture.homeDir, messageBuffer: new MessageBuffer(),
        baseUrlOverride: state.baseUrl, managedServerLaunchFingerprint: targetFingerprint,
      });

      await reapUnusedSharedManagedOpenCodeServersBestEffort();

      expect(isOpenCodeServerPidAlive(fixture.pid)).toBe(true);
      expect(existsSync(targetPath)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('leaves an external explicit-URL process alive through client disposal and periodic reconciliation', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    try {
      await fixture.removeState();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ healthy: true, version: 'fake-opencode' }));
      const client = await fixture.createClient({
        directory: fixture.homeDir, messageBuffer: new MessageBuffer(),
        baseUrlOverride: 'http://127.0.0.1:9999',
      });

      await client.dispose();
      await reapUnusedSharedManagedOpenCodeServersBestEffort();

      expect(isOpenCodeServerPidAlive(fixture.pid)).toBe(true);
      expect(existsSync(fixture.statePath)).toBe(false);
      expect(existsSync(`${fixture.statePath}.clients`)).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('isolates tracked clients from the released flat scanner while retaining explicit legacy reads', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    try {
      const state = await fixture.publish();
      const legacyDirectory = dirname(dirname(fixture.statePath));
      const legacyPath = join(legacyDirectory, `${'b'.repeat(64)}.json`);
      const legacyBaseUrl = 'http://127.0.0.1:9998';
      await writeFile(legacyPath, JSON.stringify({
        ...state, baseUrl: legacyBaseUrl, launchEnvFingerprint: basename(legacyPath, '.json'),
      }));

      // cli-v0.2.17/cli-v0.2.17-preview.1, a2c45c86804b24e60ac0b76146a3ef36dfcaa15b,
      // sharedManagedServer.ts:1414–1428: the released scanner lists only flat *.json entries.
      // Preserve that exact discovery operation, rather than reconstructing its whole protocol.
      const entries = (await readdir(legacyDirectory))
        .filter((entry) => entry.endsWith('.json'));
      const releasedScannerPaths = entries.map((entry) => join(legacyDirectory, entry));

      expect(releasedScannerPaths).toContain(legacyPath);
      expect(releasedScannerPaths).not.toContain(fixture.statePath);
      expect(await readSharedManagedOpenCodeServerStateByBaseUrlBestEffort(legacyBaseUrl))
        .toMatchObject({ pid: fixture.pid, baseUrl: legacyBaseUrl, ownerToken: state.ownerToken });
      await reapUnusedSharedManagedOpenCodeServersBestEffort();
      expect(existsSync(legacyPath)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('ignores an unpublished partial client record when reclaiming an unused server', async () => {
    const fixture = await createManagedOpenCodeClientFixture();
    try {
      const claimDirectory = `${fixture.statePath}.clients`;
      await mkdir(claimDirectory, { recursive: true });
      await writeFile(join(claimDirectory, 'interrupted.json.tmp'), '{"pid":');

      await reapUnusedSharedManagedOpenCodeServersBestEffort();

      expect(await waitForProcessExit(fixture.pid, { timeoutMs: 1_000 })).toBe(true);
      expect(existsSync(fixture.statePath)).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});

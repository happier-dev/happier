/**
 * Opt-in daemon reattach integration tests.
 *
 * These tests spawn real processes and rely on `ps-list` classification.
 *
 * Enable with: `HAPPIER_CLI_DAEMON_REATTACH_INTEGRATION=1`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { waitForPidInspection } from '@/testkit/process/pidInspection';
import type { TrackedSession } from './types';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { projectPath } from '@/projectPath';
import { readProcessIdentityByPid } from './processIdentity';
import {
  shouldRunDaemonReattachIntegration,
  spawnHappyLookingProcess,
} from './testkit/realIntegration.testkit';

describe.skipIf(!shouldRunDaemonReattachIntegration())(
  'reattach (real) integration tests (opt-in)',
  { timeout: 20_000 },
  () => {
    let envScope: ReturnType<typeof createEnvKeyScope>;
    const spawned: Array<() => void> = [];
    const tempHomes: string[] = [];
    let reattach: typeof import('./sessions/reattachFromMarkers').reattachTrackedSessionsFromMarkers;

    beforeEach(async () => {
      envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
      const home = createTempDirSync('happier-cli-daemon-reattach-test-');
      tempHomes.push(home);
      envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'reattach-test' });
      vi.resetModules();
      ({ reattachTrackedSessionsFromMarkers: reattach } = await import('./sessions/reattachFromMarkers'));
    });

    afterEach(() => {
      for (const k of spawned.splice(0)) k();
      for (const home of tempHomes.splice(0)) {
        removeTempDirSync(home);
      }
      envScope.restore();
      vi.resetModules();
    });

    it('adopts a marker only when PID is alive and command hash matches', async () => {
      const { adoptSessionsFromMarkers } = await import('./reattach');
      const { findAllHappyProcesses, findHappyProcessByPid } = await import('./doctor');
      const { hashProcessCommand, listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

      const p = spawnHappyLookingProcess();
      spawned.push(p.kill);

      const proc = await waitForPidInspection(findHappyProcessByPid, p.pid);
      expect(proc).not.toBeNull();
      if (!proc) return;

      const metadata: Metadata = {
        path: '/tmp',
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: process.env.HAPPIER_HOME_DIR!,
        happyLibDir: '/tmp',
        happyToolsDir: '/tmp',
        hostPid: p.pid,
        startedBy: 'terminal',
        machineId: 'test-machine',
      };

      await writeSessionMarker({
        pid: p.pid,
        happySessionId: 'sess-1',
        startedBy: 'terminal',
        cwd: '/tmp',
        processCommandHash: hashProcessCommand(proc.command),
        processCommand: proc.command,
        metadata,
      });

      const markers = await listSessionMarkers();
      expect(markers).toHaveLength(1);

      const happyProcesses = await findAllHappyProcesses();
      const map = new Map<number, TrackedSession>();
      const identity = await readProcessIdentityByPid(p.pid);
      const { adopted } = adoptSessionsFromMarkers({ markers, happyProcesses, pidToTrackedSession: map,
        processIdentityByPid: new Map(identity ? [[p.pid, identity]] : []) });
      expect(adopted).toBe(1);
      expect(map.get(p.pid)?.reattachedFromDiskMarker).toBe(true);
      expect(map.get(p.pid)?.processCommandHash).toBe(hashProcessCommand(proc.command));
    });

    it('heals an incomplete marker with the canonical OS command hash, not the longer discovery command', async () => {
      const { findHappyProcessByPid } = await import('./doctor');
      const { readProcessIdentityByPid } = await import('./processIdentity');
      const { writeSessionMarker, readSessionMarkerForPid, hashProcessCommand } = await import('./sessionRegistry');
      const child = spawnTestProcess(process.execPath, ['-e',
        `/* ${projectPath()}/bin/happier.mjs codex --started-by daemon --existing-session healed-canonical-reader ${'x'.repeat(1500)} */ setInterval(() => {}, 1000)`]);
      const pid = child.pid!;
      spawned.push(() => { child.kill('SIGTERM'); });
      const discovery = await waitForPidInspection(findHappyProcessByPid, pid);
      const identity = await readProcessIdentityByPid(pid);
      expect(discovery?.command.length).toBeGreaterThan(identity!.command.length);
      await writeSessionMarker({ pid, happySessionId: 'healed-canonical-reader', startedBy: 'daemon', cwd: process.cwd() });
      const sessions = new Map<number, TrackedSession>();
      await reattach({ pidToTrackedSession: sessions });
      expect(sessions.get(pid)?.processCommandHash).toBe(hashProcessCommand(identity!.command));
      expect((await readSessionMarkerForPid(pid))?.processCommandHash).toBe(hashProcessCommand(identity!.command));
      expect((await readSessionMarkerForPid(pid))?.processStartTimeMs).toBe(identity!.processStartTimeMs);
    });

    it('rejects foreign scope in markerless and poisoned-marker recovery, including placeholder recovery', async () => {
      const { findHappyProcessByPid } = await import('./doctor');
      const { clearProcessSnapshotCacheForTests } = await import('./processSnapshotCache');
      const { hashProcessCommand, listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
      for (const withSessionId of [true, false]) {
        const child = spawnTestProcess(process.execPath, [
          '-e', `/* ${projectPath()}/bin/happier.mjs --started-by daemon ${withSessionId ? '--existing-session foreign-home' : ''} */ setInterval(() => {}, 1000000)`,
        ], { env: { ...process.env, HAPPIER_HOME_DIR: `${process.env.HAPPIER_HOME_DIR}-foreign` } });
        spawned.push(() => { child.kill('SIGTERM'); });
        const proc = await waitForPidInspection(findHappyProcessByPid, child.pid!);
        expect(proc?.daemonOwnershipEnvironmentVariables?.HAPPIER_HOME_DIR).toBe(`${process.env.HAPPIER_HOME_DIR}-foreign`);
        const tracked = new Map<number, TrackedSession>();
        clearProcessSnapshotCacheForTests();
        await reattach({ pidToTrackedSession: tracked });
        expect(tracked.has(child.pid!)).toBe(false);
        expect((await listSessionMarkers()).some((marker) => marker.pid === child.pid)).toBe(false);
        await writeSessionMarker({ pid: child.pid!, happySessionId: 'foreign-home', startedBy: 'daemon',
          processCommandHash: hashProcessCommand(proc!.command), processCommand: proc!.command });
        await reattach({ pidToTrackedSession: tracked });
        expect(tracked.has(child.pid!)).toBe(false);
        process.kill(child.pid!, 0);
      }
    });

    it('recovers proven lifecycle across endpoint changes and legacy scope, but rejects foreign or unknown scope', async () => {
      const { findHappyProcessByPid } = await import('./doctor');
      const { configuration } = await import('@/configuration');
      for (const scenario of [
        { name: 'same-scope', scope: 'reattach-test', home: process.env.HAPPIER_HOME_DIR, expected: true },
        { name: 'foreign-scope', scope: 'foreign', home: process.env.HAPPIER_HOME_DIR, expected: false },
        { name: 'unknown-scope', scope: undefined, home: undefined, expected: false },
        { name: 'legacy-scope', scope: undefined, home: process.env.HAPPIER_HOME_DIR, expected: true },
      ]) {
        const legacy = scenario.name === 'legacy-scope';
        if (legacy) envScope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
        const child = spawnTestProcess(process.execPath, [
          '-e', `/* ${projectPath()}/bin/happier.mjs --started-by daemon --existing-session ${scenario.name} */ setInterval(() => {}, 1000000)`,
        ], { env: { ...process.env, HAPPIER_HOME_DIR: scenario.home,
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: scenario.scope,
          HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
          HAPPIER_SERVER_URL: legacy ? configuration.serverUrl : 'https://old-endpoint.example' } });
        spawned.push(() => { child.kill('SIGTERM'); });
        await waitForPidInspection(findHappyProcessByPid, child.pid!);
        const { clearProcessSnapshotCacheForTests: clearSnapshot } = await import('./processSnapshotCache');
        clearSnapshot();
        const { findAllHappyProcesses } = await import('./doctor');
        expect((await findAllHappyProcesses()).some((proc) => proc.pid === child.pid), scenario.name).toBe(true);
        const tracked = new Map<number, TrackedSession>();
        await reattach({ pidToTrackedSession: tracked });
        expect(tracked.has(child.pid!), scenario.name).toBe(scenario.expected);
      }
    });

    it('does not adopt when marker hash mismatches (fail-closed)', async () => {
      const { adoptSessionsFromMarkers } = await import('./reattach');
      const { findAllHappyProcesses, findHappyProcessByPid } = await import('./doctor');
      const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

      const p = spawnHappyLookingProcess();
      spawned.push(p.kill);

      const proc = await waitForPidInspection(findHappyProcessByPid, p.pid);
      expect(proc).not.toBeNull();
      if (!proc) return;

      await writeSessionMarker({
        pid: p.pid,
        happySessionId: 'sess-2',
        startedBy: 'terminal',
        processCommandHash: '0'.repeat(64),
        processCommand: proc.command,
      });

      const markers = await listSessionMarkers();
      const happyProcesses = await findAllHappyProcesses();
      const map = new Map<number, TrackedSession>();
      const identity = await readProcessIdentityByPid(p.pid);
      const { adopted } = adoptSessionsFromMarkers({ markers, happyProcesses, pidToTrackedSession: map,
        processIdentityByPid: new Map(identity ? [[p.pid, identity]] : []) });
      expect(adopted).toBe(0);
      expect(map.size).toBe(0);
    });
  },
);

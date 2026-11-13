/**
 * Opt-in daemon reattach integration tests.
 *
 * These tests spawn real processes and rely on census-backed classification.
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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  shouldRunDaemonReattachIntegration,
  spawnHappyLookingProcess,
} from './testkit/realIntegration.testkit';
import { legacyPidSessionTrackingKey, type SessionTrackingKey, trackedSessionsForProcess } from '@/daemon/sessions/sessionTrackingKey';

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
        trackingKey: legacyPidSessionTrackingKey(p.pid), pid: p.pid,
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
      const map = new Map<SessionTrackingKey, TrackedSession>();
      const identity = await readProcessIdentityByPid(p.pid);
      const { adopted } = adoptSessionsFromMarkers({ markers, happyProcesses, trackedSessionsByKey: map,
        processIdentityByPid: new Map(identity ? [[p.pid, identity]] : []) });
      expect(adopted).toBe(1);
      expect(map.get(legacyPidSessionTrackingKey(p.pid))?.reattachedFromDiskMarker).toBe(true);
      expect(map.get(legacyPidSessionTrackingKey(p.pid))?.processCommandHash).toBe(hashProcessCommand(proc.command));
    });

    it('adopts the surviving built Stack runner with the same marker generation into a successor registry', async () => {
      const { writeSessionMarker, readSessionMarker, hashProcessCommand } = await import('./sessionRegistry');
      const home = process.env.HAPPIER_HOME_DIR!;
      const entrypoint = join(home, 'source-bundles', 'bundle-fixture', 'apps', 'cli', 'src', 'index.mjs');
      await mkdir(join(entrypoint, '..'), { recursive: true });
      await writeFile(entrypoint, 'setInterval(() => {}, 1000);\n');
      const child = spawnTestProcess(process.execPath, [entrypoint, 'claude', '--happy-starting-mode', 'remote', '--started-by', 'daemon']);
      const pid = child.pid!;
      spawned.push(() => { child.kill('SIGTERM'); });
      const before = await waitForPidInspection(readProcessIdentityByPid, pid);
      expect(before).not.toBeNull();
      const processCommandHash = hashProcessCommand(before!.command);
      const authorityPath = join(home, 'tmp', 'agent-runtime-daemon-service-authorities', 'original.json');
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: 'built-stack-session', startedBy: 'daemon', cwd: home,
        processCommand: before!.command, processCommandHash, processStartTimeMs: before!.processStartTimeMs,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath });
      const sessions = new Map<SessionTrackingKey, TrackedSession>();
      await reattach({ trackedSessionsByKey: sessions });
      expect(sessions.get(legacyPidSessionTrackingKey(pid))).toMatchObject({ happySessionId: 'built-stack-session', reattachedFromDiskMarker: true,
        processCommandHash, processStartTimeMs: before!.processStartTimeMs, agentRuntimeDaemonServiceAuthorityFilePath: authorityPath });
      expect(await readSessionMarker(legacyPidSessionTrackingKey(pid))).toMatchObject({ pid, happySessionId: 'built-stack-session',
        processCommandHash, processStartTimeMs: before!.processStartTimeMs });
      expect(await readProcessIdentityByPid(pid)).toMatchObject({ pid, processStartTimeMs: before!.processStartTimeMs });
      process.kill(pid, 0);
    });

    it.each([true, false])('heals an incomplete marker and restores materialized custody only with its captured process generation (%s)', async (withCapturedGeneration) => {
      const { findHappyProcessByPid } = await import('./doctor');
      const { readProcessIdentityByPid } = await import('./processIdentity');
      const { writeSessionMarker, readSessionMarker, hashProcessCommand } = await import('./sessionRegistry');
      const child = spawnTestProcess(process.execPath, ['-e',
        `/* ${projectPath()}/bin/happier.mjs codex --started-by daemon --existing-session healed-canonical-reader ${'x'.repeat(1500)} */ setInterval(() => {}, 1000)`]);
      const pid = child.pid!;
      spawned.push(() => { child.kill('SIGTERM'); });
      const discovery = await waitForPidInspection(findHappyProcessByPid, pid);
      const identity = await readProcessIdentityByPid(pid);
      expect(discovery?.command).toBe(identity!.command);
      const materializedStateObservationBinding: NonNullable<TrackedSession['materializedStateObservationBinding']> = {
        agentId: 'fixture-agent', pluginId: 'fixture-plugin',
        sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
        nativeHomeRoot: join(process.env.HAPPIER_HOME_DIR!, 'native-home'),
        entries: [{ entryPath: 'projects', sourceEntryRoot: '/native/projects', materializedEntryPath: join(process.env.HAPPIER_HOME_DIR!, 'native-home/projects') }],
      };
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: 'healed-canonical-reader', startedBy: 'daemon', cwd: process.cwd(),
        ...(withCapturedGeneration ? { processStartTimeMs: identity!.processStartTimeMs } : {}),
        materializedStateObservationBinding });
      const sessions = new Map<SessionTrackingKey, TrackedSession>();
      await reattach({ trackedSessionsByKey: sessions });
      expect(sessions.get(legacyPidSessionTrackingKey(pid))?.processCommandHash).toBe(hashProcessCommand(identity!.command));
      // A start witness already admits exact adoption; only witness-less
      // recovery heals the diagnostic command hash.
      expect((await readSessionMarker(legacyPidSessionTrackingKey(pid)))?.processCommandHash).toBe(withCapturedGeneration ? undefined : hashProcessCommand(identity!.command));
      expect((await readSessionMarker(legacyPidSessionTrackingKey(pid)))?.processStartTimeMs).toBe(identity!.processStartTimeMs);
      expect(sessions.get(legacyPidSessionTrackingKey(pid))?.materializedStateObservationBinding).toEqual(withCapturedGeneration ? materializedStateObservationBinding : undefined);
      expect((await readSessionMarker(legacyPidSessionTrackingKey(pid)))?.materializedStateObservationBinding).toEqual(withCapturedGeneration ? materializedStateObservationBinding : undefined);
    });

    it('rejects foreign scope in markerless and poisoned-marker recovery, including placeholder recovery', async () => {
      const { findHappyProcessByPid } = await import('./doctor');
      const { hashProcessCommand, listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
      for (const withSessionId of [true, false]) {
        const child = spawnTestProcess(process.execPath, [
          '-e', `/* ${projectPath()}/bin/happier.mjs --started-by daemon ${withSessionId ? '--existing-session foreign-home' : ''} */ setInterval(() => {}, 1000000)`,
        ], { env: { ...process.env, HAPPIER_HOME_DIR: `${process.env.HAPPIER_HOME_DIR}-foreign` } });
        spawned.push(() => { child.kill('SIGTERM'); });
        const proc = await waitForPidInspection(findHappyProcessByPid, child.pid!);
        expect(proc?.daemonOwnershipEnvironmentVariables?.HAPPIER_HOME_DIR).toBe(`${process.env.HAPPIER_HOME_DIR}-foreign`);
        const tracked = new Map<SessionTrackingKey, TrackedSession>();
        await reattach({ trackedSessionsByKey: tracked });
        expect(trackedSessionsForProcess(tracked, child.pid!)).toHaveLength(0);
        expect((await listSessionMarkers()).some((marker) => marker.pid === child.pid)).toBe(false);
        await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(child.pid!), pid: child.pid!, happySessionId: 'foreign-home', startedBy: 'daemon',
          processCommandHash: hashProcessCommand(proc!.command), processCommand: proc!.command });
        await reattach({ trackedSessionsByKey: tracked });
        expect(trackedSessionsForProcess(tracked, child.pid!)).toHaveLength(0);
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
        const { findAllHappyProcesses } = await import('./doctor');
        expect((await findAllHappyProcesses()).some((proc) => proc.pid === child.pid), scenario.name).toBe(true);
        const tracked = new Map<SessionTrackingKey, TrackedSession>();
        await reattach({ trackedSessionsByKey: tracked });
        expect(trackedSessionsForProcess(tracked, child.pid!).length > 0, scenario.name).toBe(scenario.expected);
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
        trackingKey: legacyPidSessionTrackingKey(p.pid), pid: p.pid,
        happySessionId: 'sess-2',
        startedBy: 'terminal',
        processCommandHash: '0'.repeat(64),
        processCommand: proc.command,
      });

      const markers = await listSessionMarkers();
      const happyProcesses = await findAllHappyProcesses();
      const map = new Map<SessionTrackingKey, TrackedSession>();
      const identity = await readProcessIdentityByPid(p.pid);
      const { adopted } = adoptSessionsFromMarkers({ markers, happyProcesses, trackedSessionsByKey: map,
        processIdentityByPid: new Map(identity ? [[p.pid, identity]] : []) });
      expect(adopted).toBe(0);
      expect(map.size).toBe(0);
    });
  },
);

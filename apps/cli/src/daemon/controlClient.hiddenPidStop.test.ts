import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DaemonLockRecord } from '@happier-dev/cli-common/process';
import { resolveDaemonStateCandidatePaths } from './ownership/daemonOwnershipPaths';
import { configuration } from '@/configuration';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { reserveEphemeralPort, waitForHttpReady } from '@/testkit/http/portUtils';
import { spawnSleepyDetachedProcess, spawnStoppableHttpDaemon, withConfiguredDaemonTestHome, writeDaemonStateFixture } from './testkit/fakeDaemonLifecycle.testkit';

let controlClient: typeof import('./controlClient');
let multiDaemon: typeof import('./multiDaemon');
let daemonCommand: typeof import('@/cli/commands/daemon');
const pendingImports = new Set(['controlClient', 'multiDaemon', 'daemonCommand']);
beforeAll(async () => {
  // Normal commands load this graph lazily after worker dispatch. Prepare it
  // before timed cases, then request its dependencies without competing evaluations.
  await import('@/cli/commands/daemonControl');
  daemonCommand = await import('@/cli/commands/daemon');
  pendingImports.delete('daemonCommand');
  controlClient = await import('./controlClient');
  pendingImports.delete('controlClient');
  multiDaemon = await import('./multiDaemon');
  pendingImports.delete('multiDaemon');
}, 300_000);
afterAll(() => {
  if (pendingImports.size > 0) console.error('Daemon stop fixture imports did not settle', [...pendingImports]);
});

// The HTTP service and child are real. Only the caller's PID namespace is an OS boundary fixture.
describe('confirmed stop across a hidden daemon PID namespace', () => {

  it('preserves another departed lock owner when force stop targets a different PID', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-dead-other-lock-' }, async () => {
      const target = spawnSleepyDetachedProcess();
      const replacement = spawnSleepyDetachedProcess();
      expect(await target.kill()).toBe(true);
      expect(await replacement.kill()).toBe(true);
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      const replacementRaw = String(replacement.pid);
      writeFileSync(configuration.daemonLockFile, replacementRaw);
      await controlClient.forceStopKnownDaemonPid(target.pid);
      expect(readFileSync(configuration.daemonLockFile, 'utf8')).toBe(replacementRaw);
    });
  });

  it.each([
    ['single', 'legacy'], ['all', 'legacy'], ['single', 'structured'], ['all', 'structured'],
  ] as const)('%s stop reclaims a dead %s lock without a state publication', async (mode, format) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-dead-lock-' }, async () => {
      const child = spawnSleepyDetachedProcess();
      expect(await child.kill()).toBe(true);
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, format === 'legacy' ? String(child.pid) : JSON.stringify({
        t: 'happier_daemon_lock_v2', pid: child.pid, ownerToken: '00000000-0000-0000-0000-000000000001', processStartedAtMs: 0, createdAtMs: 0,
      } satisfies DaemonLockRecord));
      await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).resolves.toEqual(mode === 'single' ? { status: 'stopped', method: 'force' } : { status: 'not_running' });
      expect(existsSync(configuration.daemonLockFile)).toBe(false);
    });
  });

  it.each(['state', 'lock'] as const)('preserves a replacement %s observed during a dead owner probe', async (changed) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-dead-successor-' }, async ({ homeDir }) => {
      const child = spawnSleepyDetachedProcess();
      expect(await child.kill()).toBe(true);
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: 43123, controlToken: 'old-token' });
      writeFileSync(configuration.daemonLockFile, String(child.pid));
      const oldState = readFileSync(configuration.daemonStateFile, 'utf8');
      const oldLock = readFileSync(configuration.daemonLockFile, 'utf8');
      const newState = JSON.stringify({ pid: process.pid, httpPort: 43124, startedAt: Date.now(), startedWithCliVersion: '0.0.0-test', controlToken: 'new-token' });
      const newLock = String(process.pid);
      // The network probe is the external boundary at which another daemon can publish.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        writeFileSync(changed === 'state' ? configuration.daemonStateFile : configuration.daemonLockFile, changed === 'state' ? newState : newLock);
        throw Object.assign(new Error('control endpoint refused'), { cause: { code: 'ECONNREFUSED' } });
      });
      try {
        await expect(controlClient.stopDaemon()).resolves.toEqual({ status: 'not_running' });
        expect(readFileSync(configuration.daemonStateFile, 'utf8')).toBe(changed === 'state' ? newState : oldState);
        expect(readFileSync(configuration.daemonLockFile, 'utf8')).toBe(changed === 'lock' ? newLock : oldLock);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it.each(['state', 'lock'] as const)('reclaims a proven-dead %s sibling after a hidden owner stops', async (kind) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-stale-sibling-' }, async ({ homeDir }) => {
      const exited = spawnSleepyDetachedProcess();
      expect(await exited.kill()).toBe(true);
      const legacyPath = resolveDaemonStateCandidatePaths({ serverDir: dirname(configuration.daemonStateFile), preferredRing: configuration.publicReleaseRing }).find(path => path !== configuration.daemonStateFile)!;
      if (kind === 'state') {
        await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: exited.pid, httpPort: 43123 });
        renameSync(configuration.daemonStateFile, legacyPath);
      }
      writeFileSync(`${legacyPath}.lock`, String(exited.pid));
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(multiDaemon.stopAllDaemonsBestEffort()).resolves.toEqual({ status: 'stopped', stoppedCount: 1 });
        expect(existsSync(`${legacyPath}.lock`)).toBe(false);
        if (kind === 'state') expect(existsSync(legacyPath)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each([
    ['single', false], ['single', true], ['all', false], ['all', true],
  ] as const)('%s stop reports a genuinely exited published owner absent (stale lock: %s)', async (mode, staleLock) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-published-exited-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', ...(staleLock ? { lockFile: configuration.daemonLockFile } : {}) });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        expect(await child.kill()).toBe(true);
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).resolves.toEqual({ status: 'not_running' });
        expect(existsSync(statePath)).toBe(false);
        if (staleLock) expect(existsSync(configuration.daemonLockFile)).toBe(false);
      } finally {
        await child.kill();
      }
    });
  });
  it.each(['single', 'all'] as const)('%s stop cannot confirm hidden exit without an observed lifecycle lock', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-no-lock-', env: { HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '0' } }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token' });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it('keeps a successor startup lock fail-closed in the observed hidden publication scope', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-successor-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const successor = spawnSleepyDetachedProcess(['/repo/dist/index.mjs', 'daemon', 'start-sync']);
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile, successorLockPid: successor.pid });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid || pid === successor.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: successor.pid });
        expect(readFileSync(configuration.daemonLockFile, 'utf8')).toBe(String(successor.pid));
        expect(realKill(successor.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
        await successor.kill();
      }
    });
  });
  it.each(['single', 'all'] as const)('%s stop keeps unreadable authenticated liveness incomplete', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-ping-failure-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 500, { controlToken: 'owned-token', pingStatus: 500, lockFile: configuration.daemonLockFile });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        expect(await controlClient.inspectDaemonRunningStateAndCleanupStaleState()).toMatchObject({ status: 'starting', state: { pid: child.pid } });
        if (mode === 'single') expect((await multiDaemon.listDaemonStatusesForAllKnownServers()).find(entry => entry.serverId === configuration.activeServerId)?.daemon).toMatchObject({ presence: 'unverified', staleStateFile: false });
        if (mode === 'single') {
          const lines: string[] = [];
          const print = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
          const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
          try {
            await expect(daemonCommand.handleDaemonCliCommand({ args: ['daemon', 'status', '--all'], rawArgv: [], terminalRuntime: null })).rejects.toThrow('exit:0');
            expect(lines.some(line => line.includes('Daemon: unverified'))).toBe(true);
          } finally {
            print.mockRestore();
            exit.mockRestore();
          }
        }
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(existsSync(statePath)).toBe(true);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each([['single', 200], ['all', 200], ['single', 500], ['all', 500]] as const)('%s stop waits for lifecycle lock release after control closes (ping %s)', async (mode, pingStatus) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-lock-retained-', env: { HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '250' } }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile, retainLockAfterControlClose: true, pingStatus });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(existsSync(configuration.daemonLockFile)).toBe(true);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each(['single', 'all'] as const)('%s stop refuses to report absence when authenticated control refuses shutdown', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-refusal-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 500, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token', machineId: 'owned-machine' });
      const originalState = readFileSync(statePath, 'utf8');
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        if (mode === 'single') {
          expect(await multiDaemon.resolveLiveDaemonExternalActionEndpoint(`http://127.0.0.1:${port}`)).toEqual({ machineId: 'owned-machine' });
          expect((await multiDaemon.listDaemonStatusesForAllKnownServers()).find((entry) => entry.daemon.pid === child.pid)?.daemon.running).toBe(true);
        }
        const stop = mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort();
        await expect(stop).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(readFileSync(statePath, 'utf8')).toBe(originalState);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each(['single', 'all'] as const)('%s stop verifies authenticated control ceased after accepted shutdown', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-accepted-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        const stop = mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort();
        await expect(stop).resolves.toEqual(mode === 'single' ? { status: 'stopped', method: 'graceful' } : { status: 'stopped', stoppedCount: 1 });
        vi.restoreAllMocks();
        expect(await waitForProcessExit(child.pid, { timeoutMs: 2_000 })).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it('all stop fails when an accepted shutdown keeps authenticated control live', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-unconfirmed-', env: { HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '0' } }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', exitOnStop: false, lockFile: configuration.daemonLockFile });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(existsSync(statePath)).toBe(true);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { DaemonLockRecord } from '@happier-dev/cli-common/process';
import { resolveDaemonStateCandidatePaths } from './ownership/daemonOwnershipPaths';
import { configuration } from '@/configuration';
import { spawnTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
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

  it('preserves a live successor publication during concurrent status inspection', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-live-successor-status-' }, async () => {
      const { acquireDaemonLock, releaseDaemonLock, writeDaemonStateForLockOwner } = await import('@/persistence');
      const predecessor = await acquireDaemonLock();
      expect(predecessor).not.toBeNull();
      const oldState = { pid: process.pid, httpPort: 43123, startedAt: 1, startedWithCliVersion: 'test', controlToken: 'predecessor' };
      expect(writeDaemonStateForLockOwner(predecessor!, oldState)).toBe(true);
      await releaseDaemonLock(predecessor!);
      const childSource = `
        const { acquireDaemonLock, releaseDaemonLock, writeDaemonStateForLockOwner } = await import(${JSON.stringify(new URL('../persistence.ts', import.meta.url).href)});
        const lock = await acquireDaemonLock();
        if (!lock) throw new Error('Successor could not acquire lifecycle lock');
        const state = { ...${JSON.stringify(oldState)}, pid: process.pid, startedAt: 2, controlToken: 'successor' };
        if (!writeDaemonStateForLockOwner(lock, state)) throw new Error('Successor initial publication failed');
        process.on('message', async message => {
          if (message === 'publish') process.send(writeDaemonStateForLockOwner(lock, { ...state, httpPort: 43124 }));
          if (message === 'release') { await releaseDaemonLock(lock); process.exit(0); }
        });
        process.send(state);
      `;
      const child = spawnTestProcess(process.execPath, [
        '--import', fileURLToPath(new URL('../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)),
        '--conditions=happier-source', '--input-type=module', '-e', childSource,
        '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync',
      ], { env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.runtime.json', import.meta.url)) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let childError = '';
      child.stderr?.on('data', data => { childError += String(data); });
      const readMessage = () => Promise.race([
        once(child, 'message').then(([message]) => message as unknown),
        once(child, 'exit').then(([code]) => { throw new Error(`Successor exited ${code}: ${childError}`); }),
      ]);
      let restoreProbe: (() => void) | undefined;
      try {
        const successorState = await readMessage();
        expect(successorState).toMatchObject({ pid: child.pid, controlToken: 'successor' });
        const published = JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8')) as typeof oldState;
        const stateRaw = readFileSync(configuration.daemonStateFile, 'utf8');
        const lockRaw = readFileSync(configuration.daemonLockFile, 'utf8');
        // Retired control routing is network evidence, never proof either live PID has exited.
        const probe = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
        restoreProbe = () => { probe.mockRestore(); };
        const observation = controlClient.observePublishedDaemonOwner(published);
        await Promise.all([
          controlClient.inspectDaemonRunningStateAndCleanupStaleState(),
          (async () => { expect(await observation.isPresent()).toBe(false); await observation.reclaimIfDead(); })(),
        ]);
        expect(readFileSync(configuration.daemonStateFile, 'utf8')).toBe(stateRaw);
        expect(readFileSync(configuration.daemonLockFile, 'utf8')).toBe(lockRaw);
        expect(process.kill(process.pid, 0)).toBe(true);
        expect(process.kill(child.pid!, 0)).toBe(true);
        const publishedAgain = readMessage();
        child.send('publish');
        expect(await publishedAgain).toBe(true);
      } finally {
        restoreProbe?.();
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
    });
  }, 300_000);

  // DAEMON-STALE-STATE-1114: a reboot can leave both coordinates owned by strangers.
  it.each((['dead', 'foreign', 'other-daemon'] as const).flatMap(kind =>
    (['inspect', 'stop'] as const).map(operation => ({ kind, operation }))))('$operation replaces a $kind PID publication with a reused foreign control port without signalling it', async ({ kind, operation }) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-reused-coordinates-' }, async ({ homeDir }) => {
      const { createServer } = await import('node:http');
      const server = createServer((req, res) => { req.resume(); res.writeHead(404); res.end('foreign endpoint'); });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      const child = spawnSleepyDetachedProcess(kind === 'other-daemon' ? ['/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'] : []);
      if (kind === 'dead') expect(await child.kill()).toBe(true);
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: address.port, controlToken: 'stale-token' });
      writeFileSync(configuration.daemonLockFile, String(child.pid));
      const realKill = process.kill.bind(process);
      const signals: number[] = [];
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === child.pid && signal !== 0) signals.push(pid);
        return realKill(pid, signal);
      });
      try {
        if (operation === 'inspect') expect(await controlClient.inspectDaemonRunningStateAndCleanupStaleState()).toEqual({ status: 'not-running' });
        else await expect(controlClient.stopDaemon()).resolves.toEqual({ status: 'not_running' });
        expect((await multiDaemon.readDaemonStateForServerId(configuration.activeServerId))?.running ?? false).toBe(false);
        expect(await multiDaemon.resolveLiveDaemonControlTargetForServer(configuration.activeServerId)).toBeNull();
        await expect(controlClient.stopDaemon()).resolves.toEqual({ status: 'not_running' });
        expect(existsSync(statePath)).toBe(kind !== 'dead');
        expect(existsSync(configuration.daemonLockFile)).toBe(kind !== 'dead');
        expect(signals).toEqual([]);
        if (kind !== 'dead') expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        spy.mockRestore();
        await child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  });

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

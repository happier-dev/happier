// Prepare the real normal-command runtime during collection, as before lazy worker dispatch.
import './daemonControl';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { configuration, reloadConfiguration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { projectPath } from '@/projectPath';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { listDaemonStatusesForAllKnownServers, resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import { DoctorSnapshotDaemonStatusSchema } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { handleDaemonCliCommand } from './daemon';

const boundary = vi.hoisted(() => ({ launch: vi.fn<() => Promise<ChildProcess>>() }));
// Substitute only the detached process launcher. Ownership, persisted state,
// readiness polling and command output all use their production owners.
vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: () => boundary.launch(),
}));

afterEach(() => { vi.restoreAllMocks(); });

describe('daemon start pending readiness', () => {
  it.each(['ready', 'failed'] as const)('waits beyond the checkpoint for its unpublished child to become %s', async outcome => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS', 'HAPPIER_DAEMON_STARTUP_SOURCE',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
    try {
      await withTempDir('happier-fix14-nl1-readiness-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://home.example.test',
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: 'https://home.example.test', HAPPIER_ACTIVE_SERVER_ID: 'fix14-nl1',
          HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1', HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir, HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'fix14-nl1' });
        reloadConfiguration();
        let child: ChildProcess | undefined;
        let checkpointReached!: () => void;
        const checkpoint = new Promise<void>(resolve => { checkpointReached = resolve; });
        boundary.launch.mockImplementation(async () => {
          child = spawn(process.execPath, ['-e', `
            process.once('message', outcome => {
              if (outcome === 'failed') process.exit(1);
              const server = require('node:http').createServer((req, res) => {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ success: true }));
              });
              server.listen(0, '127.0.0.1', () => process.send(server.address().port));
            });
          `, join(projectPath(), 'dist/index.mjs'), 'daemon', 'start-sync'],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
          await once(child, 'spawn');
          // Advance the real wait owner's monotonic clock past its checkpoint;
          // the OS child remains held before any state/lock publication.
          let reads = 0;
          vi.spyOn(performance, 'now').mockImplementation(() => {
            if (reads++ === 0) return 0;
            checkpointReached();
            return 2;
          });
          return child;
        });
        vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
        const output = captureStdoutJsonOutput<{ ok: boolean; status?: string; error?: string }>();
        let invocation: Promise<unknown> | undefined;
        try {
          invocation = handleDaemonCliCommand({ args: ['daemon', 'start', '--json'], rawArgv: [], terminalRuntime: null })
            .catch(error => error);
          await checkpoint;
          if (!child?.pid) throw new Error('Missing fixture process PID');
          if (outcome === 'ready') {
            const listening = once(child, 'message');
            child.send(outcome);
            const [port] = await listening;
            if (typeof port !== 'number') throw new Error('Missing fixture control port');
            writeDaemonState({ pid: child.pid, httpPort: port, controlToken: 'fixture-control-token',
              startedAt: Date.now(), startedWithCliVersion: configuration.currentCliVersion,
              startedWithPublicReleaseChannel: 'dev', machineControlReady: true, startupSource: 'manual' });
          } else {
            const exited = once(child, 'exit');
            child.send(outcome);
            await exited;
          }
          expect(await invocation).toMatchObject({ message: outcome === 'ready' ? 'exit:0' : 'exit:1' });
          expect(output.json()).toMatchObject(outcome === 'ready'
            ? { ok: true, status: 'started' } : { ok: false, error: 'start_failed' });
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
          }
          await invocation;
          output.restore();
        }
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });

  it.each([
    { httpPort: 0, startupSource: 'manual' as const },
    { httpPort: 1, startupSource: 'manual' as const },
    { httpPort: 0, startupSource: 'background-service' as const },
  ])('returns pending at its reporting budget and preserves stop ownership ($startupSource, port $httpPort)', async ({ httpPort, startupSource }) => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS', 'HAPPIER_DAEMON_STARTUP_SOURCE',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
    try {
      await withTempDir('happier-start-pending-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://home.example.test',
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: 'https://home.example.test', HAPPIER_ACTIVE_SERVER_ID: 'pending',
          HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1', HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir, HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'pending' });
        reloadConfiguration();
        let child: ChildProcess | undefined;
        boundary.launch.mockImplementation(async () => {
          child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)',
            join(projectPath(), 'dist/index.mjs'), 'daemon', 'start-sync'], { stdio: 'ignore' });
          await once(child, 'spawn');
          if (!child.pid) throw new Error('Missing fixture process PID');
          // An unreachable control endpoint is an existing starting-state shape.
          const identity = await readProcessIdentityByPid(child.pid);
          if (!identity?.processStartTimeMs) throw new Error('Missing fixture process generation');
          await mkdir(dirname(configuration.daemonLockFile), { recursive: true });
          await writeFile(configuration.daemonLockFile, JSON.stringify({ t: 'happier_daemon_lock_v2',
            pid: child.pid, ownerToken: '00000000-0000-4000-8000-000000000004',
            processStartedAtMs: identity.processStartTimeMs, createdAtMs: Date.now() }));
          writeDaemonState({ pid: child.pid, httpPort, ...(httpPort ? { controlToken: 'fixture-control-token' } : {}),
            startedAt: Date.now(), startedWithCliVersion: configuration.currentCliVersion,
            startedWithPublicReleaseChannel: 'dev', machineControlReady: false, startupSource });
          return child;
        });
        vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
        const output = captureStdoutJsonOutput<{ ok: boolean; status: string }>();
        let invocation: Promise<unknown> | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          invocation = handleDaemonCliCommand({ args: ['daemon', 'start', '--json'], rawArgv: [], terminalRuntime: null })
            .catch(error => error);
          const result = await Promise.race([invocation, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('start command did not return while startup remained pending')), 5_000);
          })]);
          expect(result).toMatchObject({ message: 'exit:0' });
          expect(output.json()).toMatchObject({ ok: true, status: 'starting' });
          expect(child?.exitCode).toBeNull();
          const status = await readDaemonStatusSnapshot();
          expect(status.daemon.httpPort).toBe(httpPort || null);
          expect(DoctorSnapshotDaemonStatusSchema.safeParse(status).success).toBe(true);
          expect((await listDaemonStatusesForAllKnownServers()).find(entry => entry.serverId === configuration.activeServerId)?.daemon.httpPort)
            .toBe(httpPort || null);
          if (!httpPort) expect(await resolveLiveDaemonControlTargetForServer(configuration.activeServerId)).toBeNull();
          await expect(handleDaemonCliCommand({ args: ['daemon', 'stop', '--json'], rawArgv: [], terminalRuntime: null }))
            .rejects.toThrow(startupSource === 'manual' ? 'exit:0' : 'exit:1');
          if (startupSource === 'manual') expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
          else expect(child?.exitCode).toBeNull();
        } finally {
          if (deadline) clearTimeout(deadline);
          if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
          }
          await invocation;
          output.restore();
        }
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });
});

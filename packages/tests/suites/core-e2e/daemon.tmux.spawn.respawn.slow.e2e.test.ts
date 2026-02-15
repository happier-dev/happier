import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { sleep, waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { yarnCommand } from '../../src/testkit/process/commands';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';

function tmuxAvailable(): boolean {
  if (process.platform === 'win32') return false;
  const res = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return res.status === 0;
}

type DaemonListChild = { happySessionId: string; pid: number };

function parseDaemonListChildren(data: unknown): DaemonListChild[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const childrenRaw = record.children;
  if (!Array.isArray(childrenRaw)) return [];
  return childrenRaw.flatMap((child) => {
    if (!child || typeof child !== 'object') return [];
    const c = child as Record<string, unknown>;
    const sessionId = typeof c.happySessionId === 'string' ? c.happySessionId : typeof c.sessionId === 'string' ? c.sessionId : null;
    const pid = typeof c.pid === 'number' ? c.pid : null;
    if (!sessionId || !pid || pid <= 0) return [];
    return [{ happySessionId: sessionId, pid }];
  });
}

type TerminalAttachmentInfoV1 = {
  version: 1;
  sessionId: string;
  terminal: { mode: 'plain' | 'tmux'; tmux?: { target?: string; tmpDir?: string } };
  updatedAt: number;
};

async function waitForAnyAttachmentInfo(happyHomeDir: string): Promise<TerminalAttachmentInfoV1> {
  const dir = resolve(join(happyHomeDir, 'terminal', 'sessions'));
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      await sleep(100);
      continue;
    }

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = resolve(join(dir, name));

      const s1 = await stat(full).catch(() => null);
      if (!s1) continue;
      await sleep(25);
      const s2 = await stat(full).catch(() => null);
      if (!s2 || s2.size !== s1.size) continue;

      const raw = await readFile(full, 'utf8').catch(() => '');
      try {
        const parsed = JSON.parse(raw) as Partial<TerminalAttachmentInfoV1>;
        if (parsed && parsed.version === 1 && typeof parsed.sessionId === 'string' && parsed.terminal) {
          return parsed as TerminalAttachmentInfoV1;
        }
      } catch {
        // ignore
      }
    }

    await sleep(100);
  }
  throw new Error(`Timed out waiting for terminal attachment info under ${dir}`);
}

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: daemon tmux spawn respawn supervision', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it(
    'respawns a tmux session runner after unexpected termination and does not respawn after explicit stop',
    async () => {
      if (!tmuxAvailable()) return;
      if (typeof (process as any).getuid !== 'function') return;

      let tmuxTmpDir: string | null = null;
      let tmuxSessionName: string | null = null;
      let daemonPort: number | null = null;
      let sessionId: string | null = null;
      let pid1: number | null = null;

      const testDir = run.testDir('daemon-tmux-spawn-respawn');
      const startedAt = new Date().toISOString();
      server = await startServerLight({ testDir, dbProvider: 'sqlite' });
      const serverBaseUrl = server.baseUrl;
      const auth = await createTestAuth(serverBaseUrl);

      const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
      const workspaceDir = resolve(join(testDir, 'workspace'));
      await mkdir(daemonHomeDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });

      const fakeClaudePath = fakeClaudeFixturePath();
      const machineKey = Uint8Array.from(randomBytes(32));
      await seedCliDataKeyAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, machineKey });

      writeTestManifestForServer({
        testDir,
        server,
        startedAt,
        runId: run.runId,
        testName: 'daemon-tmux-spawn-respawn',
        sessionIds: [],
        env: {
          CI: process.env.CI,
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
        },
      });

      await runLoggedCommand({
        command: yarnCommand(),
        args: ['-s', 'workspace', '@happier-dev/cli', 'build'],
        cwd: repoRootDir(),
        env: { ...process.env, CI: '1' },
        stdoutPath: resolve(join(testDir, 'cli.build.stdout.log')),
        stderrPath: resolve(join(testDir, 'cli.build.stderr.log')),
        timeoutMs: 240_000,
      });

      try {
        daemon = await startTestDaemon({
          testDir,
          happyHomeDir: daemonHomeDir,
          env: {
            ...process.env,
            CI: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: server.baseUrl,
            HAPPIER_CLAUDE_PATH: fakeClaudePath,
            HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '5000',
            HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS: '50',
            HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS: '250',
            HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS: '0',
          },
        });
        daemonPort = daemon.state.httpPort;
        const controlToken = (daemon.state as any)?.controlToken as string | undefined;

        await waitFor(async () => {
          const res = await daemonControlPostJson({ port: daemonPort!, path: '/list', body: {}, controlToken });
          return res.status === 200;
        }, { timeoutMs: 20_000 });

        const shortTmpBase = process.platform === 'win32' ? tmpdir() : '/tmp';
        tmuxTmpDir = await mkdtemp(join(shortTmpBase, 'happy-e2e-tmux-'));
        tmuxSessionName = `happy-e2e-${randomUUID().slice(0, 8)}`;

        const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
          port: daemonPort,
          path: '/spawn-session',
          controlToken,
          body: {
            directory: workspaceDir,
            terminal: {
              mode: 'tmux',
              tmux: { sessionName: tmuxSessionName, isolated: true, tmpDir: tmuxTmpDir },
            },
            environmentVariables: {
              HAPPIER_HOME_DIR: daemonHomeDir,
              HAPPIER_SERVER_URL: server.baseUrl,
              HAPPIER_WEBAPP_URL: server.baseUrl,
              HAPPIER_VARIANT: 'dev',
              HAPPIER_DISABLE_CAFFEINATE: '1',
            },
          },
        });

        expect(spawnRes.status).toBe(200);
        expect(spawnRes.data.success).toBe(true);
        const attachment = await waitForAnyAttachmentInfo(daemonHomeDir);
        sessionId = attachment.sessionId;
        expect(typeof sessionId).toBe('string');
        expect(sessionId.length).toBeGreaterThan(0);

        let observedPid1: number | null = null;
        await waitFor(async () => {
          const res = await daemonControlPostJson({ port: daemonPort!, path: '/list', body: {}, controlToken });
          if (res.status !== 200) throw new Error(`Unexpected /list status ${res.status}`);
          const children = parseDaemonListChildren(res.data);
          const match = children.find((c) => c.happySessionId === sessionId);
          if (!match) {
            throw new Error(`session not yet listed (sessionId=${sessionId}, children=${children.map((c) => `${c.happySessionId}:${c.pid}`).join(',')})`);
          }
          observedPid1 = match.pid;
          return true;
        }, { timeoutMs: 30_000 });
        pid1 = observedPid1;

        if (pid1 == null) throw new Error('Missing pid1 after daemon /list resolved');
        expect(pid1).toBeGreaterThan(0);
        try {
          process.kill(pid1, 'SIGKILL');
        } catch {
          // ignore
        }

        let observedPid2: number | null = null;
        await waitFor(async () => {
          const res = await daemonControlPostJson({ port: daemonPort!, path: '/list', body: {}, controlToken });
          if (res.status !== 200) throw new Error(`Unexpected /list status ${res.status}`);
          const children = parseDaemonListChildren(res.data);
          const match = children.find((c) => c.happySessionId === sessionId);
          if (!match) throw new Error('session not yet listed');
          if (match.pid === pid1) throw new Error('still on old pid');
          observedPid2 = match.pid;
          return true;
        }, { timeoutMs: 30_000 });
        const pid2 = observedPid2!;

        expect(pid2).toBeGreaterThan(0);
        expect(pid2).not.toBe(pid1);

        const stopRes = await daemonControlPostJson<{ success: boolean }>({
          port: daemonPort!,
          path: '/stop-session',
          body: { sessionId },
          controlToken,
        });
        expect(stopRes.status).toBe(200);
        expect(stopRes.data.success).toBe(true);

        await waitFor(async () => {
          const res = await daemonControlPostJson({ port: daemonPort!, path: '/list', body: {}, controlToken });
          if (res.status !== 200) throw new Error(`Unexpected /list status ${res.status}`);
          const children = parseDaemonListChildren(res.data);
          if (children.some((c) => c.happySessionId === sessionId)) throw new Error('session still listed');
          return true;
        }, { timeoutMs: 20_000 });

        await sleep(1_000);
        const afterStop = await daemonControlPostJson({ port: daemonPort!, path: '/list', body: {}, controlToken });
        expect(afterStop.status).toBe(200);
        expect(parseDaemonListChildren(afterStop.data).some((c) => c.happySessionId === sessionId)).toBe(false);
      } finally {
        if (tmuxSessionName && tmuxTmpDir) {
          try {
            const uid = (process as any).getuid() as number;
            const socketPath = `${tmuxTmpDir}/tmux-${uid}/default`;
            if (existsSync(socketPath)) {
              spawnSync('tmux', ['-S', socketPath, 'kill-session', '-t', tmuxSessionName], { stdio: 'ignore' });
            }
          } catch {
            // ignore
          }
        }
        if (tmuxTmpDir) {
          await rm(tmuxTmpDir, { recursive: true, force: true }).catch(() => {});
        }
        if (pid1) {
          try {
            process.kill(pid1, 0);
            process.kill(pid1, 'SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    },
    120_000,
  );
});

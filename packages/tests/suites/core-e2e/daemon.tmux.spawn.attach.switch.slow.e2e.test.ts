import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { sleep, waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { yarnCommand } from '../../src/testkit/process/commands';
import { fakeClaudeFixturePath, type FakeClaudeInvocation, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

type TerminalAttachmentInfoV1 = {
  version: 1;
  sessionId: string;
  terminal: { mode: 'plain' | 'tmux'; tmux?: { target?: string; tmpDir?: string } };
  updatedAt: number;
};

function tmuxAvailable(): boolean {
  if (process.platform === 'win32') return false;
  const res = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return res.status === 0;
}

function attachmentInfoPath(happyHomeDir: string, sessionId: string): string {
  return join(happyHomeDir, 'terminal', 'sessions', `${encodeURIComponent(sessionId)}.json`);
}

async function waitForAttachmentInfo(happyHomeDir: string, sessionId: string): Promise<TerminalAttachmentInfoV1> {
  const path = attachmentInfoPath(happyHomeDir, sessionId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (!existsSync(path)) {
      await sleep(100);
      continue;
    }
    // Best-effort: avoid reading while another process is mid-write (can yield partial JSON).
    const s1 = await stat(path).catch(() => null);
    if (!s1) {
      await sleep(100);
      continue;
    }
    await sleep(25);
    const s2 = await stat(path).catch(() => null);
    if (!s2 || s2.size !== s1.size) {
      await sleep(100);
      continue;
    }
    const raw = await readFile(path, 'utf8').catch(() => '');
    try {
      const parsed = JSON.parse(raw) as Partial<TerminalAttachmentInfoV1>;
      if (parsed && parsed.version === 1 && parsed.sessionId === sessionId && parsed.terminal) {
        return parsed as TerminalAttachmentInfoV1;
      }
    } catch {
      // ignore
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for terminal attachment info at ${path}`);
}

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: daemon tmux spawn → attach → Claude remote↔local switching', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('spawns a Claude session in tmux, persists attachment info, attaches non-interactively, and switches remote→local→remote', async () => {
    if (!tmuxAvailable()) return;
    if (typeof (process as any).getuid !== 'function') return;

    let tmuxTmpDir: string | null = null;
    let tmuxSessionName: string | null = null;
    let daemonPort: number | null = null;
    let sessionId: string | null = null;

    const testDir = run.testDir('daemon-tmux-spawn-attach-switch');
    const startedAt = new Date().toISOString();
    // This test targets daemon/tmux/session-switch behavior and is not intended as a DB-portability assertion.
    // Force sqlite for deterministic control-plane timing across environments.
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    // Deterministic fake Claude boundary for the session process (no external Claude install needed).
    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

    // Legacy encryption secret shared by the daemon + spawned session process.
    const secret = Uint8Array.from(randomBytes(32));

    // Seed daemon credentials + settings to avoid interactive auth flows.
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'daemon-tmux-spawn-attach-switch',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
      },
    });

    // Ensure the CLI is built because the daemon spawns child sessions via dist/index.mjs.
    const cliDistEntrypoint = resolve(repoRootDir(), 'apps/cli/dist/index.mjs');
    if (!existsSync(cliDistEntrypoint)) {
      await runLoggedCommand({
        command: yarnCommand(),
        args: ['-s', 'workspace', '@happier-dev/cli', 'build'],
        cwd: repoRootDir(),
        env: { ...process.env, CI: '1' },
        stdoutPath: resolve(join(testDir, 'cli.build.stdout.log')),
        stderrPath: resolve(join(testDir, 'cli.build.stderr.log')),
        timeoutMs: 240_000,
      });
    }

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
          // Ensure both local + remote Claude runners use the fake CLI.
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
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

      // Spawn a new session via daemon control server (same code path as the app uses).
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
            // Prove env propagation into the tmux window (fake Claude writes logs only when this is set).
            HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
            // Keep the spawned session isolated from the developer machine.
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
      sessionId = spawnRes.data.sessionId ?? null;
      expect(typeof sessionId).toBe('string');
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

      // Wait for terminal attachment info (written by the spawned session process).
      const info = await waitForAttachmentInfo(daemonHomeDir, sessionId);
      expect(info.terminal.mode).toBe('tmux');
      const target = info.terminal.tmux?.target;
      expect(typeof target).toBe('string');
      if (typeof target !== 'string' || target.length === 0) throw new Error('Missing terminal.tmux.target in attachment info');

      // Attach non-interactively: emulate being already inside the same isolated tmux server.
      const uid = (process as any).getuid() as number;
      const socketPath = `${tmuxTmpDir}/tmux-${uid}/default`;
      expect(existsSync(socketPath)).toBe(true);

      const attachRes = spawnSync(
        process.execPath,
        [cliDistEntrypoint, 'attach', sessionId],
        {
          cwd: repoRootDir(),
          env: {
            ...process.env,
            CI: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_HOME_DIR: daemonHomeDir,
            // "Inside tmux" (this isolated server) to avoid interactive attach-session.
            TMUX: `${socketPath},0,0`,
            TMUX_PANE: '%0',
          },
          encoding: 'utf8',
        },
      );
      expect(attachRes.status).toBe(0);

      // Assert tmux now has the target window active.
      const parts = target.split(':');
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const windowName = parts[1];
      expect(windowName.length).toBeGreaterThan(0);
      const windows = spawnSync('tmux', ['list-windows', '-t', tmuxSessionName, '-F', '#{window_active} #{window_name}'], {
        env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir, TMUX: `${socketPath},0,0` },
        encoding: 'utf8',
      });
      expect(windows.status).toBe(0);
      const active = (windows.stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => l.startsWith('1 '));
      expect(active).toBe(`1 ${windowName}`);

      // Switch remote → local via encrypted RPC, then verify local Claude spawn occurred (fake logs).
      const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
      ui.connect();
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      await requestSessionSwitchRpc({ ui, sessionId, to: 'local', secret, timeoutMs: 25_000 });

      const localInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLogPath,
        (i) => i.mode === 'local' && i.argv.includes('--settings'),
        { timeoutMs: 45_000, pollMs: 150 },
      );
      expect(Object.prototype.hasOwnProperty.call(localInvocation.mergedMcpServers, 'happy')).toBe(true);

      // Trigger a UI message to force local → remote switch, then ensure the SDK runner invokes fake Claude.
      await postEncryptedUiTextMessage({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
        text: 'E2E_SWITCH_BACK_TO_REMOTE',
      });

      const sdkInvocation: FakeClaudeInvocation = await waitForFakeClaudeInvocation(
        fakeLogPath,
        (i) => i.mode === 'sdk',
        { timeoutMs: 45_000, pollMs: 150 },
      );
      expect(Object.prototype.hasOwnProperty.call(sdkInvocation.mergedMcpServers, 'happy')).toBe(true);
      // Legacy remote runner still uses `--settings` for SessionStart hook forwarding.
      expect(sdkInvocation.argv).toContain('--settings');

      ui.close();
    } finally {
      if (daemonPort && sessionId) {
        await daemonControlPostJson({ port: daemonPort, path: '/stop-session', body: { sessionId }, controlToken: (daemon?.state as any)?.controlToken }).catch(() => {});
      }
      await daemon?.stop().catch(() => {});

      if (tmuxTmpDir && tmuxSessionName) {
        spawnSync('tmux', ['kill-session', '-t', tmuxSessionName], {
          env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
          stdio: 'ignore',
        });
      }
      if (tmuxTmpDir) {
        await rm(tmuxTmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 240_000);
});

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';

function yarnCommand(): string {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

function tmuxAvailable(): boolean {
  if (process.platform === 'win32') return false;
  const res = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return res.status === 0;
}

function runTmux(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string } {
  const res = spawnSync('tmux', args, { env, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed (status=${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return { stdout: res.stdout || '', stderr: res.stderr || '' };
}

const run = createRunDirs({ runLabel: 'core' });
const tmuxAttachPrerequisitesMet = tmuxAvailable() && typeof (process as any).getuid === 'function';

describe('core e2e: tmux attach selects the correct window (isolated tmux server)', () => {
  it.skipIf(!tmuxAttachPrerequisitesMet)('runs select-window against the tmux target from terminal attachment info', async () => {
    const testDir = run.testDir('tmux-attach-select-window');
    const happyHomeDir = resolve(join(testDir, 'happier-home'));
    await mkdir(happyHomeDir, { recursive: true });

    const sessionId = randomUUID();
    // tmux socket paths have a relatively small maximum length. Keep TMUX_TMPDIR short.
    const tmuxTmpDir = await mkdtemp(join(tmpdir(), 'happy-e2e-tmux-'));

    const uid = (process as any).getuid() as number;
    const socketPath = join(tmuxTmpDir, `tmux-${uid}`, 'default');
    const tmuxEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxTmpDir };

    const tmuxSessionName = `happy-e2e-${randomUUID().slice(0, 8)}`;
    const mainWindow = 'main';
    const otherWindow = 'other';
    const target = `${tmuxSessionName}:${mainWindow}`;

    const terminalSessionsDir = join(happyHomeDir, 'terminal', 'sessions');
    await mkdir(terminalSessionsDir, { recursive: true });
    const attachmentInfoPath = join(terminalSessionsDir, `${encodeURIComponent(sessionId)}.json`);

    // Minimal structure accepted by `readTerminalAttachmentInfo` + `createTerminalAttachPlan`.
    await writeFile(
      attachmentInfoPath,
      JSON.stringify(
        {
          version: 1,
          sessionId,
          updatedAt: Date.now(),
          terminal: {
            mode: 'tmux',
            tmux: { target },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    let created = false;
    try {
      // Start a completely isolated tmux server via TMUX_TMPDIR.
      runTmux(['new-session', '-d', '-s', tmuxSessionName, '-n', mainWindow], tmuxEnv);
      runTmux(['new-window', '-t', tmuxSessionName, '-n', otherWindow], tmuxEnv);
      runTmux(['select-window', '-t', `${tmuxSessionName}:${otherWindow}`], tmuxEnv);
      created = true;

      // Ensure the socket exists so we can emulate "inside tmux" for the isolated server.
      if (!existsSync(socketPath)) {
        throw new Error(`Expected isolated tmux socket to exist at ${socketPath}`);
      }

      const envForAttach: NodeJS.ProcessEnv = {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_HOME_DIR: happyHomeDir,
        TMUX_TMPDIR: tmuxTmpDir,
        // Emulate being inside *this* isolated tmux server. This avoids `attach-session` and keeps the test non-interactive.
        TMUX: `${socketPath},0,0`,
        TMUX_PANE: '%0',
      };

      const attachRes = spawnSync(
        yarnCommand(),
        ['-s', 'workspace', '@happier-dev/cli', 'dev', 'attach', sessionId],
        { cwd: repoRootDir(), env: envForAttach, encoding: 'utf8' },
      );
      expect(attachRes.status).toBe(0);

      const windows = runTmux(['list-windows', '-t', tmuxSessionName, '-F', '#{window_active} #{window_name}'], {
        ...tmuxEnv,
        TMUX: `${socketPath},0,0`,
      }).stdout;
      const active = windows
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => l.startsWith('1 '));
      expect(active).toBe(`1 ${mainWindow}`);
    } finally {
      if (created) {
        try {
          runTmux(['kill-session', '-t', tmuxSessionName], tmuxEnv);
        } catch {
          // ignore
        }
      }
      try {
        await rm(tmuxTmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }, 180_000);
});

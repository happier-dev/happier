import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Codex fast-start', () => {
  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;
  let cliHomeDir: string | null = null;

  afterEach(async () => {
    await proc?.stop('SIGKILL');
    proc = null;
    if (cliHomeDir) {
      await stopDaemonFromHomeDir(cliHomeDir).catch(() => {});
    }
    cliHomeDir = null;
    await server?.stop();
    server = null;
  });

  it('spawns Codex local TUI before slow create-session completes', async () => {
    const testDir = run.testDir('codex-fast-start-create-session-delay');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    cliHomeDir = cliHome;
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const codexSessionsDir = resolve(join(testDir, 'codex-sessions'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexSessionsDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeCodexPath = resolve(join(fakeBinDir, 'codex'));
    const codexSessionId = `codex-session-${randomUUID()}`;
    const rolloutPath = resolve(join(codexSessionsDir, 'rollout-test.jsonl'));

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const sessionsRoot = process.env.HAPPIER_CODEX_SESSIONS_DIR;
if (!sessionsRoot) throw new Error('Missing HAPPIER_CODEX_SESSIONS_DIR');
fs.mkdirSync(sessionsRoot, { recursive: true });

const filePath = path.join(sessionsRoot, ${JSON.stringify('rollout-test.jsonl')});
const id = process.env.HAPPIER_E2E_CODEX_SESSION_ID;
if (!id) throw new Error('Missing HAPPIER_E2E_CODEX_SESSION_ID');

fs.appendFileSync(
  filePath,
  JSON.stringify({ type: 'session_meta', payload: { id, timestamp: new Date().toISOString(), cwd: process.cwd() } }) + '\\n',
  'utf8',
);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(fakeCodexPath, 0o755);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'codex-fast-start-create-session-delay',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_CODEX_TUI_BIN: fakeCodexPath,
      },
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CODEX_TUI_BIN: fakeCodexPath,
      HAPPIER_CODEX_SESSIONS_DIR: codexSessionsDir,
      HAPPIER_E2E_CODEX_SESSION_ID: codexSessionId,
      // Enable local-control so `--happy-starting-mode local` uses the local launcher.
      HAPPIER_EXPERIMENTAL_CODEX_RESUME: '1',
      // Make server session creation slow enough that we can verify local spawn happens first.
      HAPPIER_E2E_DELAY_CREATE_SESSION_MS: '10000',
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    proc = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'codex',
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'local',
      ],
      cwd: workspaceDir,
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    await waitFor(async () => existsSync(rolloutPath), {
      timeoutMs: 5000,
      intervalMs: 25,
      context: 'fake Codex rollout file exists (spawned)',
    });

    expect(existsSync(rolloutPath)).toBe(true);
  });
});


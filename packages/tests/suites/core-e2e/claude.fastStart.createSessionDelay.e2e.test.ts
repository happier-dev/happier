import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Claude fast-start', () => {
  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;
  let cliHomeDir: string | null = null;

  afterEach(async () => {
    await proc?.stop();
    proc = null;
    if (cliHomeDir) {
      await stopDaemonFromHomeDir(cliHomeDir).catch(() => {});
    }
    cliHomeDir = null;
    await server?.stop();
    server = null;
  });

  it('spawns Claude local before slow create-session completes', async () => {
    const testDir = run.testDir('claude-fast-start-create-session-delay');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    cliHomeDir = cliHome;
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    await seedCliAuthForTestAccount({ cliHome, serverUrl: server.baseUrl, auth, mode: 'legacy' });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'claude-fast-start-create-session-delay',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
      },
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog,
      HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${randomUUID()}`,
      // Make server session creation slow enough that we can verify local spawn happens first.
      HAPPIER_E2E_DELAY_CREATE_SESSION_MS: '30000',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    };

    const cliLaunchSpec = await resolveCliTestLaunchSpec(
      { testDir, env: cliEnv },
      { snapshotDir: resolve(join(testDir, 'cli-dist')), preferSourceEntrypoint: true },
    );

    proc = spawnLoggedProcess({
      command: cliLaunchSpec.command,
      args: [
        ...cliLaunchSpec.args,
        'claude',
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'local',
      ],
      cwd: workspaceDir,
      env: {
        ...cliEnv,
        ...(cliLaunchSpec.env ?? {}),
      },
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    const invocation = await waitForFakeClaudeInvocation(
      fakeLog,
      (i) => i.mode === 'local',
      { timeoutMs: 20_000, pollMs: 25 },
    );

    expect(invocation.argv).toEqual(expect.any(Array));
  }, 240_000);
});

import { afterAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { repoRootDir } from '../../src/testkit/paths';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { yarnCommand } from '../../src/testkit/process/commands';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: daemon spawn codex token auth seeds temp CODEX_HOME from host config.toml', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('copies CODEX_HOME/config.toml into the spawned temp CODEX_HOME (token path)', async () => {
    const testDir = run.testDir('daemon-spawn-codex-temp-home-seeds-config');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const sourceCodexHomeDir = resolve(join(testDir, 'source-codex-home'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sourceCodexHomeDir, { recursive: true });

    const configMarker = `CODEX_CONFIG_SEEDED_${randomUUID()}`;
    await writeFile(join(sourceCodexHomeDir, 'config.toml'), `# ${configMarker}\n`, 'utf8');

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'daemon-spawn-codex-temp-home-seeds-config',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        CODEX_HOME: sourceCodexHomeDir,
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

    const wrapperPath = resolve(join(testDir, 'codex-acp-wrapper.mjs'));
    const logPath = resolve(join(testDir, 'codex-home-seed-log.jsonl'));
    const stubProviderPath = resolve(
      join(repoRootDir(), 'packages', 'tests', 'fixtures', 'acp-stub-provider', 'acp-stub-provider.mjs'),
    );

    await writeFile(
      wrapperPath,
      `#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

await import(pathToFileURL(${JSON.stringify(stubProviderPath)}).href);
`,
      'utf8',
    );
    await chmod(wrapperPath, 0o755);

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        // Source CODEX_HOME that buildAuthEnv should seed from.
        CODEX_HOME: sourceCodexHomeDir,
        // Test seam: let spawn hooks log which temp CODEX_HOME was created and whether config.toml was copied.
        HAPPIER_E2E_CODEX_HOME_SEED_LOG: logPath,
        // Ensure Codex uses ACP so we can run with a deterministic stub provider.
        HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
        HAPPIER_CODEX_ACP_NPX_MODE: 'never',
        HAPPIER_CODEX_ACP_BIN: wrapperPath,
        // Keep daemon steady for the test.
        HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '5000',
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
      },
    });

    const daemonPort = daemon.state.httpPort;
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    await waitFor(async () => {
      const res = await daemonControlPostJson({ port: daemonPort, path: '/list', body: {}, controlToken });
      return res.status === 200;
    }, { timeoutMs: 20_000 });

    const spawnRes = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: daemonPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        agent: 'codex',
        sessionId: `codex-seed-${randomUUID()}`,
        terminal: { mode: 'plain' },
        experimentalCodexAcp: true,
        token: 'dummy-token',
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
          HAPPIER_CODEX_ACP_NPX_MODE: 'never',
          HAPPIER_CODEX_ACP_BIN: wrapperPath,
        },
      },
      timeoutMs: 60_000,
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    expect(typeof spawnRes.data?.sessionId).toBe('string');

    const readSeedLogRecord = async (): Promise<any | null> => {
      const raw = await readFile(logPath, 'utf8');
      const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

      // The spawn hook appends JSONL; tolerate reading while the write is in-flight by
      // skipping any line that isn't valid JSON yet.
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as any;
          if (parsed?.kind === 'codex.buildAuthEnv' && parsed?.seededConfigCopied === true && typeof parsed?.tempCodexHome === 'string') {
            return parsed;
          }
        } catch {
          // ignore
        }
      }
      return null;
    };

    await waitFor(async () => {
      const record = await readSeedLogRecord();
      if (!record) return false;
      try {
        const seededConfig = await readFile(join(record.tempCodexHome, 'config.toml'), 'utf8');
        return seededConfig.includes(configMarker);
      } catch {
        return false;
      }
    }, { timeoutMs: 30_000 });

    const parsed = await readSeedLogRecord();
    expect(parsed).toBeTruthy();
    expect(parsed.kind).toBe('codex.buildAuthEnv');
    expect(typeof parsed.tempCodexHome).toBe('string');
    expect(parsed.tempCodexHome).not.toBe(sourceCodexHomeDir);
    expect(parsed.seededConfigCopied).toBe(true);

    const seededConfig = await readFile(join(parsed.tempCodexHome, 'config.toml'), 'utf8');
    expect(seededConfig).toContain(configMarker);

    await daemonControlPostJson({
      port: daemonPort,
      path: '/stop-session',
      body: { sessionId: spawnRes.data?.sessionId },
      controlToken,
      timeoutMs: 30_000,
    }).catch(() => {});
  }, 240_000);
});

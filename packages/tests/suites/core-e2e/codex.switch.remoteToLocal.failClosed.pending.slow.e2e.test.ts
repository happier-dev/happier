import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Codex remote→local switch fails closed when pending messages exist', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rejects remote→local switch while pending queue V2 has items', async () => {
    const testDir = run.testDir('codex-switch-remote-to-local-fail-closed');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const codexSessionsDir = resolve(join(testDir, 'codex-sessions'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexSessionsDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

    const now = Date.now();
    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'codex-switch-fail-closed',
        createdAt: now,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-codex-switch-fail-closed-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeCodexPath = resolve(join(fakeBinDir, 'codex'));
    const rolloutPath = resolve(join(codexSessionsDir, 'rollout-test.jsonl'));

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const sessionsRoot = process.env.HAPPIER_CODEX_SESSIONS_DIR;
fs.mkdirSync(sessionsRoot, { recursive: true });
fs.appendFileSync(path.join(sessionsRoot, ${JSON.stringify('rollout-test.jsonl')}), JSON.stringify({ type: 'session_meta', payload: { id: 'should-not-run' } }) + '\\n', 'utf8');
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
      testName: 'codex-switch-remote-to-local-fail-closed',
      sessionIds: [sessionId],
      env: {},
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_CODEX_TUI_BIN: fakeCodexPath,
      HAPPIER_CODEX_SESSIONS_DIR: codexSessionsDir,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    let proc: SpawnedProcess | null = null;
    let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;
    try {
      proc = spawnLoggedProcess({
        command: yarnCommand(),
        args: [
          '-s',
          'workspace',
          '@happier-dev/cli',
          'dev',
          'codex',
          '--existing-session',
          sessionId,
          '--started-by',
          'terminal',
          '--happy-starting-mode',
          'remote',
        ],
        cwd: repoRootDir(),
        env: cliEnv,
        stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
        stderrPath: resolve(join(testDir, 'cli.stderr.log')),
      });

      ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
      ui.connect();

      const uiCollector = ui;
      if (!uiCollector) throw new Error('UI socket collector was not created');
      await waitFor(() => uiCollector.isConnected(), { timeoutMs: 20_000 });

      await waitFor(async () => {
        const snap: any = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        return snap.active === true;
      }, { timeoutMs: 30_000 });

      // Enqueue *multiple* pending items only after the CLI is running and the UI socket is connected.
      // This reduces flakiness: the CLI may drain pending at startup, and we need pending to exist at
      // the moment the switch handler checks (fail-closed without a TTY).
      for (let i = 0; i < 5; i++) {
        const localId = `pending-${randomUUID()}`;
        const msg = {
          role: 'user',
          content: { type: 'text', text: `PENDING_MESSAGE_SHOULD_BLOCK_SWITCH_${i}` },
          localId,
          meta: { source: 'ui', sentFrom: 'e2e' },
        };
        const ciphertext = encryptLegacyBase64(msg, secret);
        const enqueue = await enqueuePendingQueueV2({ baseUrl: serverBaseUrl, token: auth.token, sessionId, localId, ciphertext, timeoutMs: 20_000 });
        expect(enqueue.status).toBe(200);
      }

      await waitFor(async () => {
        const snap: any = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        return typeof snap.pendingCount === 'number' && snap.pendingCount > 0;
      }, { timeoutMs: 20_000 });

      const switched = await requestSessionSwitchRpc({ ui: uiCollector, sessionId, to: 'local', secret, timeoutMs: 20_000 });
      expect(switched).toBe(false);

      // Give the CLI a moment; rollout file should never appear because the switch was rejected.
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(rolloutPath)).toBe(false);
    } finally {
      ui?.close();
      await proc?.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});

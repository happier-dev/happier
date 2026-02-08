import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: ACP slash command extraction publishes to metadata (OpenCode)', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('publishes metadata.slashCommands from ACP available_commands_update', async () => {
    const testDir = run.testDir('opencode-acp-slash-commands');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'opencode-acp-slash-commands',
        createdAt: Date.now(),
        permissionMode: 'default',
        permissionModeUpdatedAt: 1000,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      tag: `e2e-opencode-acp-slash-commands-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeOpenCodePath = resolve(join(fakeBinDir, 'opencode'));

    const sdkEntry = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');

    await writeFile(
      fakeOpenCodePath,
      `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const sdkPath = process.env.HAPPIER_E2E_ACP_SDK_ENTRY;
if (!sdkPath) throw new Error("Missing HAPPIER_E2E_ACP_SDK_ENTRY");
const acp = await import(pathToFileURL(sdkPath).href);

class FakeAgent {
  connection;
  constructor(connection) {
    this.connection = connection;
  }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async authenticate() { return {}; }
  async newSession() {
    const sessionId = randomUUID();
    // Emit ACP's available_commands_update, which Happy should publish into metadata.
    queueMicrotask(() => {
      void this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "plan", description: "Plan before making changes" },
            { name: "/build", description: "Implement changes" }
          ],
        },
      });
    });
    return { sessionId };
  }
  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
    });
    return { stopReason: "end_turn" };
  }
  async cancel() {}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
`,
      'utf8',
    );
    await chmod(fakeOpenCodePath, 0o755);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'opencode-acp-slash-commands',
      sessionIds: [sessionId],
      env: {},
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_E2E_ACP_SDK_ENTRY: sdkEntry,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    const proc: SpawnedProcess = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'opencode',
        '--existing-session',
        sessionId,
        '--started-by',
        'terminal',
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      const baseline = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const baselineAgentStateVersion = baseline.agentStateVersion;

      // Wait until the CLI has attached (keepalive / state updates) before enqueueing messages.
      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.active === true || (typeof snap.agentStateVersion === 'number' && snap.agentStateVersion > baselineAgentStateVersion);
      }, { timeoutMs: 45_000 });

      // Kick off the first prompt so the ACP runtime is started.
      const localId = `pending-${randomUUID()}`;
      const pendingMsg = {
        role: 'user',
        content: { type: 'text', text: 'START' },
        localId,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const pendingCiphertext = encryptLegacyBase64(pendingMsg, secret);
      const enqueue = await enqueuePendingQueueV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        localId,
        ciphertext: pendingCiphertext,
        timeoutMs: 20_000,
      });
      expect(enqueue.status).toBe(200);

      await waitFor(async () => {
        const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
        const cmds = metadata?.slashCommands;
        return Array.isArray(cmds) && cmds.includes('build') && cmds.includes('plan');
      }, { timeoutMs: 60_000 });

      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
      expect(metadata.slashCommands).toEqual(['build', 'plan']);
      expect(metadata.slashCommandDetails).toEqual([
        { command: 'build', description: 'Implement changes' },
        { command: 'plan', description: 'Plan before making changes' },
      ]);
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});

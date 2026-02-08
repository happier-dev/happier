import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2, patchSessionMetadataWithRetry } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

type FakeGeminiLogLine =
  | Readonly<{ kind: 'boot'; model: string | null }>
  | Readonly<{ kind: 'prompt'; model: string | null; prompt: string }>
  | Readonly<{ kind: 'error'; message: string }>;

function parseJsonl(raw: string): FakeGeminiLogLine[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FakeGeminiLogLine];
      } catch {
        return [];
      }
    });
}

describe('core e2e: Gemini modelOverrideV1 applies from metadata', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('uses modelOverrideV1 for the next prompt, and preserves context on model change', async () => {
    const testDir = run.testDir('gemini-modeloverride-metadata');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'gemini-modeloverride-metadata',
        createdAt: Date.now(),
        // Start on pro, switch to flash via metadata.
        modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'gemini-2.5-pro' },
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-gemini-modeloverride-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeGeminiPath = resolve(join(fakeBinDir, 'gemini'));
    const fakeGeminiLog = resolve(join(testDir, 'fake-gemini.jsonl'));

    const acpSdkEntry = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');

    await writeFile(
      fakeGeminiPath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";

function log(line) {
  const p = process.env.HAPPIER_E2E_GEMINI_LOG;
  if (!p) return;
  appendFileSync(p, JSON.stringify(line) + "\\n", "utf8");
}

log({ kind: "boot", model: process.env.GEMINI_MODEL ?? null });

const sdkEntry = ${JSON.stringify(acpSdkEntry)};
const acp = await import(pathToFileURL(sdkEntry).href);

class FakeAgent {
  connection;
  constructor(connection) { this.connection = connection; }
  async initialize(_params) {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession(_params) {
    return { sessionId: randomUUID() };
  }
  async authenticate(_params) { return {}; }
  async prompt(params) {
    const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
    const prompt = blocks
      .map((b) => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");
    log({ kind: "prompt", model: process.env.GEMINI_MODEL ?? null, prompt });
    // Emit at least one session update so the client can observe idle and complete the turn.
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OK" },
      },
    });
    return { stopReason: "end_turn" };
  }
  async cancel(_params) {}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
`,
      'utf8',
    );
    await chmod(fakeGeminiPath, 0o755);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'gemini-modeloverride-metadata',
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
      // Ensure the fake gemini CLI is used.
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      HAPPIER_E2E_GEMINI_LOG: fakeGeminiLog,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    const proc: SpawnedProcess = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'gemini',
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

    try {
      const baseline = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const baselineAgentStateVersion = baseline.agentStateVersion;

      await waitFor(async () => {
        const snap: any = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.active === true || (typeof snap.agentStateVersion === 'number' && snap.agentStateVersion > baselineAgentStateVersion);
      }, { timeoutMs: 45_000 });

      // First message should use the seeded model override (pro).
      const localId1 = `pending-${randomUUID()}`;
      const pending1 = {
        role: 'user',
        content: { type: 'text', text: 'FIRST' },
        localId: localId1,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const pendingCiphertext1 = encryptLegacyBase64(pending1, secret);
      const enqueue1 = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: localId1,
        ciphertext: pendingCiphertext1,
        timeoutMs: 20_000,
      });
      expect(enqueue1.status).toBe(200);

      await waitFor(async () => {
        if (!existsSync(fakeGeminiLog)) return false;
        const raw = await readFile(fakeGeminiLog, 'utf8').catch(() => '');
        const events = parseJsonl(raw);
        return events.some((e) => e.kind === 'prompt' && e.model === 'gemini-2.5-pro');
      }, { timeoutMs: 30_000 });

      // Patch metadata to a new model override while idle.
      const snap1 = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const meta1 = decryptLegacyBase64(snap1.metadata, secret) as any;
      const ciphertext2 = encryptLegacyBase64(
        {
          ...meta1,
          modelOverrideV1: { v: 1, updatedAt: 2000, modelId: 'gemini-2.5-flash' },
        },
        secret,
      );
      await patchSessionMetadataWithRetry({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        ciphertext: ciphertext2,
        expectedVersion: snap1.metadataVersion,
      });

      // Second message should use flash and include previous context prefix (Gemini model-change preservation).
      const localId2 = `pending-${randomUUID()}`;
      const pending2 = {
        role: 'user',
        content: { type: 'text', text: 'SECOND' },
        localId: localId2,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const pendingCiphertext2 = encryptLegacyBase64(pending2, secret);
      const enqueue2 = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: localId2,
        ciphertext: pendingCiphertext2,
        timeoutMs: 20_000,
      });
      expect(enqueue2.status).toBe(200);

      await waitFor(async () => {
        if (!existsSync(fakeGeminiLog)) return false;
        const raw = await readFile(fakeGeminiLog, 'utf8').catch(() => '');
        const events = parseJsonl(raw);
        return events.some(
          (e) =>
            e.kind === 'prompt' &&
            e.model === 'gemini-2.5-flash' &&
            typeof e.prompt === 'string' &&
            e.prompt.includes('[PREVIOUS CONVERSATION CONTEXT]') &&
            e.prompt.includes('User: FIRST'),
        );
      }, { timeoutMs: 45_000 });
    } finally {
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});

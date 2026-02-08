import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2, patchSessionMetadataWithRetry } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

type FakeCodexMcpLogLine =
  | Readonly<{ kind: 'tool'; name: string; args: any }>
  | Readonly<{ kind: 'init' }>
  | Readonly<{ kind: 'error'; message: string }>;

function parseJsonl(raw: string): FakeCodexMcpLogLine[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FakeCodexMcpLogLine];
      } catch {
        return [];
      }
    });
}

describe('core e2e: Codex MCP permission metadata updates do not restart MCP session', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('keeps using codex-reply after permissionMode changes via metadata (no extra codex startSession)', async () => {
    const testDir = run.testDir('codex-mcp-no-restart-permission-change');
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
        name: 'codex-mcp-no-restart-permission-change',
        createdAt: Date.now(),
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 1000,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      tag: `e2e-codex-mcp-no-restart-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeCodexPath = resolve(join(fakeBinDir, 'codex'));
    const fakeCodexLog = resolve(join(testDir, 'fake-codex-mcp.jsonl'));
    const sdkMcpPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
    const sdkStdioPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js');
    const zodPath = resolve(repoRootDir(), 'apps/cli/node_modules/zod/index.js');

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sdkMcpPath = ${JSON.stringify(sdkMcpPath)};
const sdkStdioPath = ${JSON.stringify(sdkStdioPath)};
const zodPath = ${JSON.stringify(zodPath)};

const { McpServer } = await import(pathToFileURL(sdkMcpPath).href);
const { StdioServerTransport } = await import(pathToFileURL(sdkStdioPath).href);
const { z } = await import(pathToFileURL(zodPath).href);

function log(line) {
  const p = process.env.HAPPIER_E2E_FAKE_CODEX_MCP_LOG;
  if (!p) return;
  appendFileSync(p, JSON.stringify(line) + '\\n', 'utf8');
}

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  // Must be >= 0.43.0-alpha.5 so the client uses 'mcp-server'.
  process.stdout.write('0.50.0\\n');
  process.exit(0);
}

const sub = argv[0];
if (sub !== 'mcp-server' && sub !== 'mcp') {
  process.stderr.write('[fake-codex] Unknown args: ' + JSON.stringify(argv) + '\\n');
  process.exit(2);
}

const server = new McpServer({ name: 'fake-codex', version: '0.0.0' });
log({ kind: 'init' });

let threadSeq = 0;
let threadId = null;
let conversationId = null;
const prompts = [];

server.registerTool(
  'codex',
  {
    title: 'codex',
    description: 'Start a Codex session',
    inputSchema: {
      prompt: z.string().optional(),
      sandbox: z.string().optional(),
      'approval-policy': z.string().optional(),
      config: z.any().optional(),
    },
  },
  async (args) => {
    threadSeq += 1;
    threadId = 'thread-' + threadSeq;
    conversationId = threadId;
    const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
    if (prompt) prompts.push(prompt);
    log({ kind: 'tool', name: 'codex', args });
    return {
      meta: { threadId, conversationId },
      content: [{ type: 'text', text: 'started:' + threadId }],
    };
  },
);

server.registerTool(
  'codex-reply',
  {
    title: 'codex-reply',
    description: 'Continue a Codex session',
    inputSchema: {
      threadId: z.string(),
      conversationId: z.string().optional(),
      prompt: z.string(),
    },
  },
  async (args) => {
    const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
    if (prompt) prompts.push(prompt);
    log({ kind: 'tool', name: 'codex-reply', args });
    return {
      meta: { threadId, conversationId },
      content: [{ type: 'text', text: 'reply:' + String(prompts.length) }],
    };
  },
);

try {
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
} catch (error) {
  log({ kind: 'error', message: String(error) });
  throw error;
}
`,
      'utf8',
    );
    await chmod(fakeCodexPath, 0o755);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'codex-mcp-no-restart-permission-change',
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
      HAPPIER_E2E_FAKE_CODEX_MCP_LOG: fakeCodexLog,
      // Ensure our fake codex binary is found.
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

    try {
      const baseline = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const baselineAgentStateVersion = baseline.agentStateVersion;

      await waitFor(async () => {
        const snap: any = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        return snap.active === true || (typeof snap.agentStateVersion === 'number' && snap.agentStateVersion > baselineAgentStateVersion);
      }, { timeoutMs: 45_000 });

      // Send first message - should trigger startSession (codex tool) exactly once.
      const localId1 = `pending-${randomUUID()}`;
      const pending1 = {
        role: 'user',
        content: { type: 'text', text: 'FIRST' },
        localId: localId1,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const pendingCiphertext1 = encryptLegacyBase64(pending1, secret);
      const enqueue1 = await enqueuePendingQueueV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        localId: localId1,
        ciphertext: pendingCiphertext1,
        timeoutMs: 20_000,
      });
      expect(enqueue1.status).toBe(200);

      await waitFor(async () => {
        if (!existsSync(fakeCodexLog)) return false;
        const raw = await readFile(fakeCodexLog, 'utf8').catch(() => '');
        const events = parseJsonl(raw);
        return events.some((e) => e.kind === 'tool' && e.name === 'codex');
      }, { timeoutMs: 30_000 });

      // Patch metadata to a newer permission mode.
      const snap1 = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const meta1 = decryptLegacyBase64(snap1.metadata, secret) as any;
      const ciphertext2 = encryptLegacyBase64(
        {
          ...meta1,
          permissionMode: 'read-only',
          permissionModeUpdatedAt: 2000,
        },
        secret,
      );
      await patchSessionMetadataWithRetry({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        ciphertext: ciphertext2,
        expectedVersion: snap1.metadataVersion,
      });

      // Send second message - should use codex-reply (no session restart / no second codex tool call).
      const localId2 = `pending-${randomUUID()}`;
      const pending2 = {
        role: 'user',
        content: { type: 'text', text: 'SECOND' },
        localId: localId2,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const pendingCiphertext2 = encryptLegacyBase64(pending2, secret);
      const enqueue2 = await enqueuePendingQueueV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        localId: localId2,
        ciphertext: pendingCiphertext2,
        timeoutMs: 20_000,
      });
      expect(enqueue2.status).toBe(200);

      await waitFor(async () => {
        if (!existsSync(fakeCodexLog)) return false;
        const raw = await readFile(fakeCodexLog, 'utf8').catch(() => '');
        const events = parseJsonl(raw);
        return events.some((e) => e.kind === 'tool' && e.name === 'codex-reply');
      }, { timeoutMs: 30_000 });

      const raw = await readFile(fakeCodexLog, 'utf8').catch(() => '');
      const events = parseJsonl(raw).filter((e): e is Extract<FakeCodexMcpLogLine, { kind: 'tool' }> => e.kind === 'tool');
      const startCalls = events.filter((e) => e.name === 'codex');
      const replyCalls = events.filter((e) => e.name === 'codex-reply');
      expect(startCalls.length).toBe(1);
      expect(replyCalls.length).toBe(1);

      const replyThreadId = replyCalls[0]?.args?.threadId ?? null;
      expect(replyThreadId).toBe('thread-1');
    } finally {
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});

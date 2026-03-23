import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { deriveSettingsSecretsKeyV1, sealSecretsDeepV1 } from '@happier-dev/protocol';

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
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';

const run = createRunDirs({ runLabel: 'core' });

type LoggedMcpServer = Readonly<{
  name: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  bridgeConfig: { transport?: string; url?: string; headers?: Record<string, string> } | null;
}>;

function parseLoggedNewSessionServers(raw: string): LoggedMcpServer[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return [];
  const parsed = JSON.parse(last) as { mcpServers?: LoggedMcpServer[] };
  return Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
}

describe('core e2e: OpenCode ACP receives resolved Happier MCP servers', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('passes global stdio and remote MCP servers into ACP newSession and decrypts saved secrets for bridge materialization', async () => {
    const testDir = run.testDir('opencode-acp-mcp-servers');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

    const now = Date.now();
    const workspaceServerId = randomUUID();
    const remoteServerId = randomUUID();
    const localSecretId = randomUUID();
    const remoteSecretId = randomUUID();
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(secret);

    const sealedSettings = sealSecretsDeepV1(
      {
        schemaVersion: 2,
        secrets: [
          {
            id: localSecretId,
            name: 'Local MCP API key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true as const, value: 'sk-local-mcp-secret' },
            createdAt: now,
            updatedAt: now,
          },
          {
            id: remoteSecretId,
            name: 'Remote MCP auth header',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true as const, value: 'Bearer remote-mcp-secret' },
            createdAt: now,
            updatedAt: now,
          },
        ],
        mcpServersSettingsV1: {
          v: 1,
          strictMode: true,
          servers: [
            {
              id: workspaceServerId,
              name: 'local_workspace',
              transport: 'stdio',
              stdio: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
              env: {
                API_KEY: { t: 'savedSecret', secretId: localSecretId },
              },
              createdAt: now,
              updatedAt: now,
            },
            {
              id: remoteServerId,
              name: 'remote_global',
              transport: 'http',
              remote: {
                url: 'https://mcp.example.test/stream',
                headers: {
                  Authorization: { t: 'savedSecret', secretId: remoteSecretId },
                },
              },
              env: {
                REMOTE_LABEL: { t: 'literal', v: 'global-remote' },
              },
              createdAt: now,
              updatedAt: now,
            },
          ],
          bindings: [
            {
              id: randomUUID(),
              serverId: workspaceServerId,
              enabled: true,
              target: { t: 'allMachines' },
              createdAt: now,
              updatedAt: now,
            },
            {
              id: randomUUID(),
              serverId: remoteServerId,
              enabled: true,
              target: { t: 'allMachines' },
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      },
      settingsSecretsKey,
      (length) => Uint8Array.from(randomBytes(length)),
    );

    await upsertEncryptedAccountSettingsV2({
      baseUrl: serverBaseUrl,
      token: auth.token,
      secret,
      settings: sealedSettings,
    });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'opencode-acp-mcp-servers',
        createdAt: Date.now(),
        permissionMode: 'default',
        permissionModeUpdatedAt: 1000,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      tag: `e2e-opencode-acp-mcp-servers-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeOpenCodePath = resolve(join(fakeBinDir, 'opencode'));
    const newSessionLogPath = resolve(join(testDir, 'new-session-log.jsonl'));
    const sdkEntry = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');

    await writeFile(
      fakeOpenCodePath,
      `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const sdkPath = process.env.HAPPIER_E2E_ACP_SDK_ENTRY;
if (!sdkPath) throw new Error("Missing HAPPIER_E2E_ACP_SDK_ENTRY");
const acp = await import(pathToFileURL(sdkPath).href);

const newSessionLog = process.env.HAPPIER_E2E_NEW_SESSION_LOG;

function normalizeServer(server) {
  const envEntries = Array.isArray(server?.env) ? server.env : [];
  const env = Object.fromEntries(envEntries.map((entry) => [String(entry?.name ?? ""), String(entry?.value ?? "")]));
  const configPath = typeof env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE === "string" ? env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE : null;
  let bridgeConfig = null;
  if (configPath) {
    try {
      bridgeConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {}
  }
  return {
    name: typeof server?.name === "string" ? server.name : null,
    command: typeof server?.command === "string" ? server.command : null,
    args: Array.isArray(server?.args) ? server.args.map((arg) => String(arg)) : [],
    env,
    bridgeConfig,
  };
}

class FakeAgent {
  connection;
  constructor(connection) {
    this.connection = connection;
  }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession(params) {
    if (newSessionLog) {
      const mcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers.map(normalizeServer) : [];
      appendFileSync(newSessionLog, JSON.stringify({ mcpServers }) + "\\n", "utf8");
    }
    return { sessionId: randomUUID() };
  }
  async authenticate() { return {}; }
  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OK" },
      },
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
      testName: 'opencode-acp-mcp-servers',
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
      HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
      HAPPIER_E2E_ACP_SDK_ENTRY: sdkEntry,
      HAPPIER_E2E_NEW_SESSION_LOG: newSessionLogPath,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
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

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.active === true || (typeof snap.agentStateVersion === 'number' && snap.agentStateVersion > baselineAgentStateVersion);
      }, { timeoutMs: 45_000 });

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
        const raw = await readFile(newSessionLogPath, 'utf8').catch(() => '');
        return parseLoggedNewSessionServers(raw).length > 0;
      }, { timeoutMs: 120_000 });

      const rawLog = await readFile(newSessionLogPath, 'utf8');
      const servers = parseLoggedNewSessionServers(rawLog);
      const byName = new Map(servers.map((entry) => [entry.name, entry]));

      expect([...byName.keys()].sort()).toEqual(['happier', 'local_workspace', 'remote_global']);

      const workspaceServer = byName.get('local_workspace');
      expect(workspaceServer?.command).toBe(process.execPath);
      expect(workspaceServer?.args).toEqual(['-e', 'process.exit(0)']);
      expect(workspaceServer?.env.API_KEY).toBe('sk-local-mcp-secret');

      const remoteServer = byName.get('remote_global');
      expect(remoteServer?.command).toBe(process.execPath);
      expect(remoteServer?.env.REMOTE_LABEL).toBe('global-remote');
      expect(remoteServer?.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE).toBeTruthy();
      expect(remoteServer?.args.join(' ')).not.toContain('remote-mcp-secret');
      expect(remoteServer?.args.join(' ')).not.toContain('https://mcp.example.test/stream');
      expect(remoteServer?.bridgeConfig).toEqual({
        transport: 'http',
        url: 'https://mcp.example.test/stream',
        headers: { Authorization: 'Bearer remote-mcp-secret' },
      });

      expect(byName.get('happier')).toBeTruthy();
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 360_000);
});

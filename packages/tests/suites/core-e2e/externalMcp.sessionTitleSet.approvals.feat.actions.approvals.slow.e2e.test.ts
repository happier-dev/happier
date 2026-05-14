import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';

const run = createRunDirs({ runLabel: 'core' });

type McpToolCallResult = {
  content?: Array<{ text?: unknown }>;
};

type ExternalMcpTransport = {
  stderr?: {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
  };
  close(): Promise<void>;
};

type ExternalMcpClient = {
  connect(transport: ExternalMcpTransport): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolCallResult>;
};

async function connectExternalMcp(params: Readonly<{
  cliEntrypoint: string;
  sessionId: string;
  cliHome: string;
  serverBaseUrl: string;
}>): Promise<{
  client: ExternalMcpClient;
  transport: ExternalMcpTransport;
  stderrLines: string[];
}> {
  const sdkClientIndexPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const sdkClientStdioPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const { Client } = await import(pathToFileURL(sdkClientIndexPath).href);
  const { StdioClientTransport } = await import(pathToFileURL(sdkClientStdioPath).href);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [params.cliEntrypoint, 'mcp', 'serve', '--session', params.sessionId],
    env: {
      ...process.env,
      CI: '1',
      HAPPIER_HOME_DIR: params.cliHome,
      HAPPIER_SERVER_URL: params.serverBaseUrl,
    },
    stderr: 'pipe',
  }) as ExternalMcpTransport;

  const stderrLines: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString('utf8'));
  });

  const client = new Client({ name: 'happier-e2e', version: '0.0.0' }) as ExternalMcpClient;
  await client.connect(transport);
  return { client, transport, stderrLines };
}

function parseToolJson<T = Record<string, unknown>>(call: McpToolCallResult): T {
  return JSON.parse(String(call.content?.[0]?.text ?? '')) as T;
}

async function createScenario(): Promise<{
  authToken: string;
  client: ExternalMcpClient;
  cliHome: string;
  secret: Uint8Array;
  server: StartedServer;
  serverBaseUrl: string;
  sessionId: string;
  stderrLines: string[];
  transport: ExternalMcpTransport;
}> {
  const testDir = run.testDir(`external-mcp-title-approvals-${randomUUID()}`);

  const server = await startServerLight({ testDir, dbProvider: 'sqlite' });
  const serverBaseUrl = server.baseUrl;
  const auth = await createTestAuth(serverBaseUrl);

  const cliHome = resolve(join(testDir, 'cli-home'));
  const workspaceDir = resolve(join(testDir, 'workspace'));
  await mkdir(cliHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const secret = Uint8Array.from(randomBytes(32));
  await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

  await upsertEncryptedAccountSettingsV2({
    baseUrl: serverBaseUrl,
    token: auth.token,
    secret,
    settings: {
      schemaVersion: 2,
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.title.set': {
            enabled: true,
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['mcp'],
          },
        },
      },
    },
  });

  const metadataCiphertextBase64 = encryptLegacyBase64(
    { path: workspaceDir, host: 'e2e', name: 'external-mcp-title-approvals', createdAt: Date.now() },
    secret,
  );
  const { sessionId } = await createSessionWithCiphertexts({
    baseUrl: serverBaseUrl,
    token: auth.token,
    tag: `e2e-external-mcp-title-approvals-${randomUUID()}`,
    metadataCiphertextBase64,
    agentStateCiphertextBase64: null,
  });

  const cliEntrypoint = await ensureCliDistBuilt(
    { testDir, env: process.env },
    { lockPath: resolve(testDir, 'cli-dist-build.lock') },
  );

  const { client, transport, stderrLines } = await connectExternalMcp({
    cliEntrypoint,
    sessionId,
    cliHome,
    serverBaseUrl,
  });

  return {
    authToken: auth.token,
    client,
    cliHome,
    secret,
    server,
    serverBaseUrl,
    sessionId,
    stderrLines,
    transport,
  };
}

describe('core e2e: external MCP approvals for session.title.set', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('returns approval_request_created for session_title_set when the MCP surface requires approval', async () => {
    const scenario = await createScenario();
    server = scenario.server;

    const snapBefore = await fetchSessionV2(scenario.serverBaseUrl, scenario.authToken, scenario.sessionId);
    const beforeMetadataVersion = snapBefore.metadataVersion;
    const beforeMetadataCiphertext = snapBefore.metadata;

    try {
      const tools = await scenario.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['session_title_set', 'action_execute']));

      const titleCall = await scenario.client.callTool({
        name: 'session_title_set',
        arguments: { sessionId: scenario.sessionId, title: 'New title from MCP' },
      });
      const titlePayload = parseToolJson(titleCall);
      expect(titlePayload).toEqual(expect.objectContaining({
        kind: 'approval_request_created',
        actionId: 'session.title.set',
        artifactId: expect.any(String),
      }));

      const snapAfterRename = await fetchSessionV2(scenario.serverBaseUrl, scenario.authToken, scenario.sessionId);
      expect(snapAfterRename.metadataVersion).toBe(beforeMetadataVersion);
      expect(snapAfterRename.metadata).toBe(beforeMetadataCiphertext);

      const decideCall = await scenario.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId: titlePayload.artifactId, decision: 'approve' },
        },
      });
      const decidePayload = parseToolJson(decideCall);
      expect(decidePayload).toEqual(expect.objectContaining({
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({ ok: true }),
        }),
      }));

      const snapAfterApproval = await fetchSessionV2(scenario.serverBaseUrl, scenario.authToken, scenario.sessionId);
      expect(snapAfterApproval.metadataVersion).toBeGreaterThan(beforeMetadataVersion);
      expect(snapAfterApproval.metadata).not.toBe(beforeMetadataCiphertext);
    } catch (error) {
      const stderrDump = scenario.stderrLines.join('');
      throw Object.assign(new Error(`external mcp stdio server failed (stderr follows)\n\n${stderrDump}`), { cause: error });
    } finally {
      await scenario.transport.close().catch(() => {});
      await scenario.client.close().catch(() => {});
    }
  }, 240_000);

  it('returns approval_request_created for action_execute session.title.set requests', async () => {
    const scenario = await createScenario();
    server = scenario.server;

    const snapBefore = await fetchSessionV2(scenario.serverBaseUrl, scenario.authToken, scenario.sessionId);
    const beforeMetadataVersion = snapBefore.metadataVersion;
    const beforeMetadataCiphertext = snapBefore.metadata;

    try {
      const actionCall = await scenario.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'session.title.set',
          input: { sessionId: scenario.sessionId, title: 'New title from action_execute' },
        },
      });
      const actionPayload = parseToolJson(actionCall);
      expect(actionPayload).toEqual(expect.objectContaining({
        kind: 'approval_request_created',
        actionId: 'session.title.set',
        artifactId: expect.any(String),
      }));

      const snapAfterRename = await fetchSessionV2(scenario.serverBaseUrl, scenario.authToken, scenario.sessionId);
      expect(snapAfterRename.metadataVersion).toBe(beforeMetadataVersion);
      expect(snapAfterRename.metadata).toBe(beforeMetadataCiphertext);

      const decideCall = await scenario.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId: actionPayload.artifactId, decision: 'approve' },
        },
      });
      const decidePayload = parseToolJson(decideCall);
      expect(decidePayload).toEqual(expect.objectContaining({
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({ ok: true }),
        }),
      }));

      const snapAfterApproval = await fetchSessionV2(scenario.serverBaseUrl, scenario.authToken, scenario.sessionId);
      expect(snapAfterApproval.metadataVersion).toBeGreaterThan(beforeMetadataVersion);
      expect(snapAfterApproval.metadata).not.toBe(beforeMetadataCiphertext);
    } catch (error) {
      const stderrDump = scenario.stderrLines.join('');
      throw Object.assign(new Error(`external mcp stdio server failed (stderr follows)\n\n${stderrDump}`), { cause: error });
    } finally {
      await scenario.transport.close().catch(() => {});
      await scenario.client.close().catch(() => {});
    }
  }, 240_000);
});

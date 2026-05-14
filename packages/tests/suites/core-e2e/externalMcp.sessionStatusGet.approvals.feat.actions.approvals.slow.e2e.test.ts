import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDecipheriv, createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decodeBase64,
  openEncryptedDataKeyEnvelopeV1,
  type ApprovalRequestV1,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { fetchArtifactViaApi, listArtifactsViaApi } from '../../src/testkit/artifactApi';
import { sleep, waitFor } from '../../src/testkit/timing';

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

async function createScenario(): Promise<{
  authToken: string;
  cliEntrypoint: string;
  cliHome: string;
  secret: Uint8Array;
  server: StartedServer;
  serverBaseUrl: string;
  sessionId: string;
}> {
  const testDir = run.testDir(`external-mcp-approvals-${randomUUID()}`);

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
          'session.status.get': {
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
    {
      path: workspaceDir,
      host: 'e2e',
      name: 'external-mcp-approvals',
      createdAt: Date.now(),
    },
    secret,
  );
  const { sessionId } = await createSessionWithCiphertexts({
    baseUrl: serverBaseUrl,
    token: auth.token,
    tag: `e2e-external-mcp-approvals-${randomUUID()}`,
    metadataCiphertextBase64,
    agentStateCiphertextBase64: null,
  });

  const cliEntrypoint = await ensureCliDistBuilt(
    { testDir, env: process.env },
    { lockPath: resolve(testDir, 'cli-dist-build.lock') },
  );

  return {
    authToken: auth.token,
    cliEntrypoint,
    cliHome,
    secret,
    server,
    serverBaseUrl,
    sessionId,
  };
}

function parseToolJson<T = Record<string, unknown>>(call: McpToolCallResult): T {
  return JSON.parse(String(call.content?.[0]?.text ?? '')) as T;
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return createHmac('sha512', key).update(data).digest();
}

function deriveArtifactRecipientSecret(secret: Uint8Array): Uint8Array {
  const textEncoder = new TextEncoder();
  const root = hmacSha512(textEncoder.encode('Happy EnCoder Master Seed'), secret);
  const childInput = new Uint8Array(1 + textEncoder.encode('content').length);
  childInput[0] = 0;
  childInput.set(textEncoder.encode('content'), 1);
  return hmacSha512(root.slice(32), childInput).slice(0, 32);
}

function unwrapSerializedJsonValue<T>(value: unknown): T {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { __happierSerializedJsonValueV1?: unknown }).__happierSerializedJsonValueV1 === true
    && (value as { type?: unknown }).type === 'json'
    && Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    return (value as { value: T }).value;
  }
  return value as T;
}

function decryptArtifactJson<T>(params: Readonly<{
  ciphertextBase64: string;
  dataEncryptionKeyBase64: string;
  secret: Uint8Array;
}>): T | null {
  const dataEncryptionKey = openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(params.dataEncryptionKeyBase64, 'base64'),
    recipientSecretKeyOrSeed: deriveArtifactRecipientSecret(params.secret),
  });
  if (!dataEncryptionKey) return null;

  const bundle = decodeBase64(params.ciphertextBase64, 'base64');
  if (bundle.length < 29 || bundle[0] !== 0) return null;

  const nonce = bundle.slice(1, 13);
  const ciphertext = bundle.slice(13, bundle.length - 16);
  const authTag = bundle.slice(bundle.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', dataEncryptionKey, nonce);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return unwrapSerializedJsonValue<T>(JSON.parse(decrypted));
}

async function waitForOpenApprovalArtifact(params: Readonly<{
  baseUrl: string;
  token: string;
  actionId: string;
  sessionId: string;
  secret: Uint8Array;
}>): Promise<string> {
  let artifactId: string | null = null;
  await waitFor(async () => {
    const artifacts = await listArtifactsViaApi({ baseUrl: params.baseUrl, token: params.token });
    for (const artifact of artifacts) {
      const header = decryptArtifactJson<Record<string, unknown>>({
        ciphertextBase64: artifact.header,
        dataEncryptionKeyBase64: artifact.dataEncryptionKey,
        secret: params.secret,
      });
      if (!header) continue;
      if (
        header.kind === 'approval_request.v1'
        && header.approvalStatus === 'open'
        && header.actionId === params.actionId
        && (
          header.sessionId === params.sessionId
          || (Array.isArray(header.sessions) && header.sessions.includes(params.sessionId))
        )
      ) {
        artifactId = artifact.id;
        return true;
      }
    }
    return false;
  }, { timeoutMs: 30_000, intervalMs: 250, context: `open approval artifact for ${params.actionId}` });

  if (!artifactId) {
    throw new Error(`Expected open approval artifact for ${params.actionId}`);
  }
  return artifactId;
}

async function expectApprovalExecutedOnce(params: Readonly<{
  baseUrl: string;
  token: string;
  artifactId: string;
  secret: Uint8Array;
}>): Promise<void> {
  const artifacts = await listArtifactsViaApi({ baseUrl: params.baseUrl, token: params.token });
  const artifact = artifacts.find((item) => item.id === params.artifactId);
  expect(artifact).toBeTruthy();
  const fullArtifact = await fetchArtifactViaApi({
    baseUrl: params.baseUrl,
    token: params.token,
    artifactId: params.artifactId,
  });
  const decrypted = decryptArtifactJson<{ body?: unknown }>({
    ciphertextBase64: fullArtifact.body,
    dataEncryptionKeyBase64: fullArtifact.dataEncryptionKey,
    secret: params.secret,
  });
  const request = typeof decrypted?.body === 'string' ? JSON.parse(decrypted.body) as ApprovalRequestV1 : null;
  expect(request).toEqual(expect.objectContaining({
    status: 'executed',
    execution: expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ ok: true }),
    }),
  }));
  const requestRecord = request as Record<string, unknown> | null;
  expect(Array.isArray(requestRecord?.executions)).toBe(false);
}

async function expectPromiseStillPending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    sleep(500).then(() => false),
  ]);
  expect(settled).toBe(false);
}

describe('core e2e: external MCP approvals for session.status.get', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('returns the underlying session status result after a blocking approval is approved', async () => {
    const scenario = await createScenario();
    server = scenario.server;

    const { client, transport, stderrLines } = await connectExternalMcp({
      cliEntrypoint: scenario.cliEntrypoint,
      sessionId: scenario.sessionId,
      cliHome: scenario.cliHome,
      serverBaseUrl: scenario.serverBaseUrl,
    });
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['session_status_get', 'action_execute']));

      const statusCallPromise = client.callTool({ name: 'session_status_get', arguments: { sessionId: scenario.sessionId, live: false } });
      void statusCallPromise.catch(() => undefined);
      const artifactId = await waitForOpenApprovalArtifact({
        baseUrl: scenario.serverBaseUrl,
        token: scenario.authToken,
        actionId: 'session.status.get',
        sessionId: scenario.sessionId,
        secret: scenario.secret,
      });

      await expectPromiseStillPending(statusCallPromise);

      const decideCall = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId, decision: 'approve' },
        },
      });
      const decidePayload = parseToolJson(decideCall);
      expect(decidePayload).toEqual(expect.objectContaining({
        ok: true,
        status: 'approved',
      }));
      expect(decidePayload).not.toEqual(expect.objectContaining({ execution: expect.anything() }));

      const statusPayload = parseToolJson(await statusCallPromise);
      expect(statusPayload).toEqual(expect.objectContaining({
        ok: true,
        session: expect.objectContaining({ id: scenario.sessionId }),
      }));
      expect(statusPayload).not.toEqual(expect.objectContaining({ kind: 'approval_request_created' }));
      await expectApprovalExecutedOnce({
        baseUrl: scenario.serverBaseUrl,
        token: scenario.authToken,
        artifactId,
        secret: scenario.secret,
      });
    } catch (error) {
      const stderrDump = stderrLines.join('');
      throw Object.assign(
        new Error(
          `external mcp stdio server failed (stderr follows)\n\n${stderrDump}`,
        ),
        { cause: error },
      );
    } finally {
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 240_000);

  it('returns approval_rejected to the original session status caller when the blocking approval is rejected', async () => {
    const scenario = await createScenario();
    server = scenario.server;

    const { client, transport, stderrLines } = await connectExternalMcp({
      cliEntrypoint: scenario.cliEntrypoint,
      sessionId: scenario.sessionId,
      cliHome: scenario.cliHome,
      serverBaseUrl: scenario.serverBaseUrl,
    });
    try {
      const statusCallPromise = client.callTool({ name: 'session_status_get', arguments: { sessionId: scenario.sessionId, live: false } });
      void statusCallPromise.catch(() => undefined);
      const artifactId = await waitForOpenApprovalArtifact({
        baseUrl: scenario.serverBaseUrl,
        token: scenario.authToken,
        actionId: 'session.status.get',
        sessionId: scenario.sessionId,
        secret: scenario.secret,
      });

      await expectPromiseStillPending(statusCallPromise);

      const decideCall = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId, decision: 'reject' },
        },
      });
      const decidePayload = parseToolJson(decideCall);
      expect(decidePayload).toEqual(expect.objectContaining({
        ok: true,
        status: 'rejected',
      }));

      const statusPayload = parseToolJson(await statusCallPromise);
      expect(statusPayload).toEqual(expect.objectContaining({
        errorCode: 'approval_rejected',
        error: 'approval_rejected',
      }));
      expect(statusPayload).not.toEqual(expect.objectContaining({ kind: 'approval_request_created' }));
    } catch (error) {
      const stderrDump = stderrLines.join('');
      throw Object.assign(new Error(`external mcp stdio server failed (stderr follows)\n\n${stderrDump}`), { cause: error });
    } finally {
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 240_000);

  it('keeps the approval artifact usable when the original blocking caller disconnects before approval', async () => {
    const scenario = await createScenario();
    server = scenario.server;

    const firstConnection = await connectExternalMcp({
      cliEntrypoint: scenario.cliEntrypoint,
      sessionId: scenario.sessionId,
      cliHome: scenario.cliHome,
      serverBaseUrl: scenario.serverBaseUrl,
    });

    let secondConnection: Awaited<ReturnType<typeof connectExternalMcp>> | null = null;
    try {
      const statusCallPromise = firstConnection.client.callTool({
        name: 'session_status_get',
        arguments: { sessionId: scenario.sessionId, live: false },
      });
      void statusCallPromise.catch(() => undefined);

      const artifactId = await waitForOpenApprovalArtifact({
        baseUrl: scenario.serverBaseUrl,
        token: scenario.authToken,
        actionId: 'session.status.get',
        sessionId: scenario.sessionId,
        secret: scenario.secret,
      });
      await expectPromiseStillPending(statusCallPromise);

      await firstConnection.transport.close().catch(() => {});
      await firstConnection.client.close().catch(() => {});

      secondConnection = await connectExternalMcp({
        cliEntrypoint: scenario.cliEntrypoint,
        sessionId: scenario.sessionId,
        cliHome: scenario.cliHome,
        serverBaseUrl: scenario.serverBaseUrl,
      });
      const decideCall = await secondConnection.client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId, decision: 'approve' },
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
    } catch (error) {
      const stderrDump = [
        firstConnection.stderrLines.join(''),
        secondConnection?.stderrLines.join('') ?? '',
      ].join('\n');
      throw Object.assign(new Error(`external mcp stdio server failed (stderr follows)\n\n${stderrDump}`), { cause: error });
    } finally {
      await secondConnection?.transport.close().catch(() => {});
      await secondConnection?.client.close().catch(() => {});
      await firstConnection.transport.close().catch(() => {});
      await firstConnection.client.close().catch(() => {});
    }
  }, 240_000);
});

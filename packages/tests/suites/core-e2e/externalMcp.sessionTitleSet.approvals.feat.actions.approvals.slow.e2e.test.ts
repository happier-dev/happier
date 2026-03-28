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
import { fetchArtifactViaApi } from '../../src/testkit/artifactApi';
import { fetchJson } from '../../src/testkit/http';

const run = createRunDirs({ runLabel: 'core' });

async function connectExternalMcp(params: Readonly<{
  cliEntrypoint: string;
  sessionId: string;
  cliHome: string;
  serverBaseUrl: string;
}>): Promise<{
  client: any;
  transport: any;
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
  });

  const stderrLines: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString('utf8'));
  });

  const client = new Client({ name: 'happier-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport, stderrLines };
}

async function assertArtifactExists(params: Readonly<{ baseUrl: string; token: string; artifactId: string }>): Promise<void> {
  const res = await fetchJson<any>(`${params.baseUrl}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (res.status !== 200) {
    throw new Error(`Expected approval artifact to exist (status=${res.status})`);
  }
}

async function assertApprovalArtifactState(params: Readonly<{
  baseUrl: string;
  token: string;
  artifactId: string;
}>): Promise<{ headerVersion: number; bodyVersion: number }> {
  const artifact = await fetchArtifactViaApi(params);
  expect(artifact.headerVersion).toBeGreaterThanOrEqual(1);
  expect(artifact.bodyVersion).toBeGreaterThanOrEqual(1);
  return { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion };
}

describe('core e2e: external MCP approvals for session.title.set', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('routes session.title.set through approvals on the mcp surface, then applies after approval', async () => {
    const testDir = run.testDir(`external-mcp-title-approvals-${randomUUID()}`);

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
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

    const snapBefore = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
    expect(snapBefore.metadataVersion).toBeGreaterThanOrEqual(0);
    const beforeMetadataVersion = snapBefore.metadataVersion;
    const beforeMetadataCiphertext = snapBefore.metadata;

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

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['session_title_set', 'action_execute']));

      const titleCall = await client.callTool({ name: 'session_title_set', arguments: { sessionId, title: 'New title from MCP' } });
      const titlePayload = JSON.parse(String((titleCall.content as any[])[0]?.text ?? ''));
      expect(titlePayload).toEqual(expect.objectContaining({
        kind: 'approval_request_created',
        actionId: 'session.title.set',
        artifactId: expect.any(String),
      }));

      await assertArtifactExists({ baseUrl: serverBaseUrl, token: auth.token, artifactId: titlePayload.artifactId });
      const approvalArtifactBeforeDecision = await assertApprovalArtifactState({
        baseUrl: serverBaseUrl,
        token: auth.token,
        artifactId: titlePayload.artifactId,
      });

      const snapAfterRequest = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      expect(snapAfterRequest.metadataVersion).toBe(beforeMetadataVersion);
      expect(snapAfterRequest.metadata).toBe(beforeMetadataCiphertext);

      const decideCall = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId: titlePayload.artifactId, decision: 'approve' },
        },
      });
      const decidePayload = JSON.parse(String((decideCall.content as any[])[0]?.text ?? ''));
      expect(decidePayload).toEqual(expect.objectContaining({
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({ ok: true }),
        }),
      }));
      const approvalArtifactAfterDecision = await assertApprovalArtifactState({
        baseUrl: serverBaseUrl,
        token: auth.token,
        artifactId: titlePayload.artifactId,
      });
      expect(approvalArtifactAfterDecision.headerVersion).toBeGreaterThanOrEqual(approvalArtifactBeforeDecision.headerVersion);
      expect(approvalArtifactAfterDecision.bodyVersion).toBeGreaterThanOrEqual(approvalArtifactBeforeDecision.bodyVersion);

      const snapAfterApprove = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      expect(snapAfterApprove.metadataVersion).toBeGreaterThan(beforeMetadataVersion);
      expect(snapAfterApprove.metadata).not.toBe(beforeMetadataCiphertext);
    } catch (error) {
      const stderrDump = stderrLines.join('');
      throw Object.assign(new Error(`external mcp stdio server failed (stderr follows)\n\n${stderrDump}`), { cause: error });
    } finally {
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 240_000);

  it('rejects a session.title.set approval without changing session metadata', async () => {
    const testDir = run.testDir(`external-mcp-title-reject-${randomUUID()}`);

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
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
      { path: workspaceDir, host: 'e2e', name: 'external-mcp-title-reject', createdAt: Date.now() },
      secret,
    );
    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      tag: `e2e-external-mcp-title-reject-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const snapBefore = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
    const beforeMetadataVersion = snapBefore.metadataVersion;
    const beforeMetadataCiphertext = snapBefore.metadata;

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

    try {
      const titleCall = await client.callTool({ name: 'session_title_set', arguments: { sessionId, title: 'Rejected title' } });
      const titlePayload = JSON.parse(String((titleCall.content as any[])[0]?.text ?? ''));
      expect(titlePayload).toEqual(expect.objectContaining({
        kind: 'approval_request_created',
        actionId: 'session.title.set',
        artifactId: expect.any(String),
      }));

      const decideCall = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId: titlePayload.artifactId, decision: 'reject' },
        },
      });
      const decidePayload = JSON.parse(String((decideCall.content as any[])[0]?.text ?? ''));
      expect(decidePayload).toEqual(expect.objectContaining({
        ok: true,
        status: 'rejected',
      }));
      const approvalArtifactBeforeDecision = await assertApprovalArtifactState({
        baseUrl: serverBaseUrl,
        token: auth.token,
        artifactId: titlePayload.artifactId,
      });
      const approvalArtifactAfterDecision = await assertApprovalArtifactState({
        baseUrl: serverBaseUrl,
        token: auth.token,
        artifactId: titlePayload.artifactId,
      });
      expect(approvalArtifactAfterDecision.headerVersion).toBeGreaterThanOrEqual(approvalArtifactBeforeDecision.headerVersion);
      expect(approvalArtifactAfterDecision.bodyVersion).toBeGreaterThanOrEqual(approvalArtifactBeforeDecision.bodyVersion);

      const snapAfterReject = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      expect(snapAfterReject.metadataVersion).toBe(beforeMetadataVersion);
      expect(snapAfterReject.metadata).toBe(beforeMetadataCiphertext);
    } catch (error) {
      const stderrDump = stderrLines.join('');
      throw Object.assign(new Error(`external mcp stdio server failed (stderr follows)\n\n${stderrDump}`), { cause: error });
    } finally {
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 240_000);
});

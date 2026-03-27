import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { fetchJson } from '../../src/testkit/http';

const run = createRunDirs({ runLabel: 'core' });

async function assertArtifactExists(params: Readonly<{ baseUrl: string; token: string; artifactId: string }>): Promise<void> {
  const res = await fetchJson<any>(`${params.baseUrl}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (res.status !== 200) {
    throw new Error(`Expected approval artifact to exist (status=${res.status})`);
  }
}

describe('core e2e: external MCP approvals for session.status.get', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('routes session.status.get through approvals on the mcp surface, then executes after approval', async () => {
    const testDir = run.testDir(`external-mcp-approvals-${randomUUID()}`);

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

    const cliEntrypoint = await ensureCliDistBuilt({ testDir, env: process.env });

    const sdkClientIndexPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const sdkClientStdioPath = resolve(repoRootDir(), 'apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
    const { Client } = await import(pathToFileURL(sdkClientIndexPath).href);
    const { StdioClientTransport } = await import(pathToFileURL(sdkClientStdioPath).href);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntrypoint, 'mcp', 'serve', '--session', sessionId],
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: cliHome,
        HAPPIER_SERVER_URL: serverBaseUrl,
      },
      stderr: 'pipe',
    });

    const stderrLines: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrLines.push(chunk.toString('utf8'));
    });

    const client = new Client({ name: 'happier-e2e', version: '0.0.0' });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['session_status_get', 'action_execute']));

      const statusCall = await client.callTool({ name: 'session_status_get', arguments: { sessionId, live: false } });
      const statusPayload = JSON.parse(String((statusCall.content as any[])[0]?.text ?? ''));
      expect(statusPayload).toEqual(expect.objectContaining({
        kind: 'approval_request_created',
        actionId: 'session.status.get',
        artifactId: expect.any(String),
      }));

      await assertArtifactExists({ baseUrl: serverBaseUrl, token: auth.token, artifactId: statusPayload.artifactId });

      const decideCall = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'approval.request.decide',
          input: { artifactId: statusPayload.artifactId, decision: 'approve' },
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
});

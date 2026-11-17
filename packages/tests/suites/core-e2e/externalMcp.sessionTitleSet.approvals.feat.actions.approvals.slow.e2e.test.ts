import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { connectExternalMcp, parseToolJson, type ExternalMcpClient, type ExternalMcpTransport } from '../../src/testkit/externalMcp';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { resolveCliTestLaunchSpec, shouldUseCliSourceEntrypoint, type CliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { withWorkspaceSourceRuntime } from '../../src/testkit/process/tsxImportHook';

const run = createRunDirs({ runLabel: 'core' });

async function createScenario(): Promise<{
  authToken: string;
  client: ExternalMcpClient;
  cliHome: string;
  cliLaunch: CliTestLaunchSpec;
  secret: Uint8Array;
  person: Awaited<ReturnType<typeof connectUiPersonActionClient>>;
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

  const secret = auth.accountSigningSeed;
  await seedCliAuthForTestAccount({ cliHome, serverUrl: serverBaseUrl, auth, mode: 'legacy' });

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

  const cliLaunch = await resolveCliTestLaunchSpec(
    { testDir, env: shouldUseCliSourceEntrypoint(process.env) ? withWorkspaceSourceRuntime(process.env) : process.env },
    { snapshotDir: resolve(testDir, 'cli-runtime'), lockPath: resolve(testDir, 'cli-dist-build.lock') },
  );

  const { client, transport, stderrLines } = await connectExternalMcp({
    cliLaunch,
    sessionId,
    cliHome,
    serverBaseUrl,
  });

  const person = await connectUiPersonActionClient({ serverUrl: serverBaseUrl, accountSecret: secret });

  return {
    person,
    authToken: auth.token,
    client,
    cliHome,
    cliLaunch,
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

      const decideCall = await scenario.person.executeConfirmed('approval.request.decide', { artifactId: titlePayload.artifactId, decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: scenario.person.serverId, actionCaller: { kind: 'host' },
      });
      expect(decideCall.ok).toBe(true);
      if (!decideCall.ok) throw new Error(`Person approval refused (${decideCall.errorCode})`);
      const decidePayload = decideCall.result;
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
      await scenario.person.close();
      await scenario.transport.close().catch(() => {});
      await scenario.client.close().catch(() => {});
      await scenario.cliLaunch.cleanup?.();
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

      const decideCall = await scenario.person.executeConfirmed('approval.request.decide', { artifactId: actionPayload.artifactId, decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: scenario.person.serverId, actionCaller: { kind: 'host' },
      });
      expect(decideCall.ok).toBe(true);
      if (!decideCall.ok) throw new Error(`Person approval refused (${decideCall.errorCode})`);
      const decidePayload = decideCall.result;
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
      await scenario.person.close();
      await scenario.transport.close().catch(() => {});
      await scenario.client.close().catch(() => {});
      await scenario.cliLaunch.cleanup?.();
    }
  }, 240_000);
});

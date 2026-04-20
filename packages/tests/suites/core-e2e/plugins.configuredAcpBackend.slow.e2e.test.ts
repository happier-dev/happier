import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';
import {
    writeEnabledLocalPathPluginState,
    writeLocalPathPluginFixture,
} from '../../src/testkit/plugins/localPathPluginFixture';

const run = createRunDirs({ runLabel: 'core' });

const ACP_STUB_PROVIDER_PATH = resolve(repoRootDir(), 'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs');
const ACP_SDK_ENTRY = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');

type DecryptedTextMessage = Readonly<{
  role?: string;
  content?: Readonly<{
    type?: string;
    text?: string;
  }>;
}>;

type DecryptedAcpAgentMessage = Readonly<{
  role?: string;
  content?: Readonly<{
    type?: string;
    provider?: string;
    data?: Readonly<{
      type?: string;
      message?: string;
    }>;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTextMessage(value: unknown): DecryptedTextMessage | null {
  return isRecord(value) ? (value as DecryptedTextMessage) : null;
}

function readAcpAgentMessage(value: unknown): DecryptedAcpAgentMessage | null {
  return isRecord(value) ? (value as DecryptedAcpAgentMessage) : null;
}

describe('core e2e: plugin-backed ACP configured backend', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('resolves a local-path plugin ACP backend end-to-end and preserves the concrete backend title in metadata and transcript', async () => {
    const testDir = run.testDir('plugin-backed-configured-acp');
    const backendId = 'acme.plugin-backed-acp.backend';
    const providerId = 'acme.plugin-backed-acp.provider';
    const pluginId = 'acme.plugin-backed-acp.plugin';

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });

    const auth = await createTestAuth(server.baseUrl);

    const cliHomeDir = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const pluginRoot = resolve(join(testDir, 'plugin-root'));
    await Promise.all([
      mkdir(cliHomeDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
      mkdir(pluginRoot, { recursive: true }),
    ]);

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: cliHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });

    await writeLocalPathPluginFixture({
      pluginRoot,
      daemonModuleContents: [
        'export async function bindTranscript() {',
        "  return 'plugin-daemon-ready';",
        '}',
        '',
      ].join('\n'),
      manifest: {
        schemaVersion: 1,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Plugin Backed ACP Integration',
        description: 'Contributes a configured ACP backend through a local-path plugin',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        contributions: {
          providers: [
            {
              kindVersion: 1,
              id: providerId,
              display: {
                name: 'Plugin Backed ACP',
                tags: ['plugin'],
              },
              ownedBackendIds: [backendId],
            },
          ],
          backends: [
            {
              kindVersion: 1,
              id: backendId,
              providerId,
              runtimeKind: 'acp',
              acp: {
                title: 'Plugin Review Bot',
                description: 'Plugin-sourced ACP backend for end-to-end validation',
                command: process.execPath,
                args: [ACP_STUB_PROVIDER_PATH],
                env: {
                  HAPPIER_E2E_ACP_SDK_ENTRY: {
                    t: 'literal',
                    v: ACP_SDK_ENTRY,
                  },
                },
                transportProfile: 'generic',
                capabilities: {
                  supportsLoadSession: true,
                  supportsModes: 'yes',
                  supportsModels: 'yes',
                  supportsConfigOptions: 'unknown',
                  promptImageSupport: 'unknown',
                },
                defaultMode: 'plan',
                defaultModel: 'plugin-pro',
              },
              capabilities: {
                directSessions: true,
              },
            },
          ],
          hooks: [],
        },
      },
    });
    await writeEnabledLocalPathPluginState({
      happyHomeDir: cliHomeDir,
      pluginRoot,
      pluginId,
    });

    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      DEBUG: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: daemonEnv,
      snapshotDir: resolve(testDir, 'cli-source-snapshot'),
    });

    const controlToken = (daemon.state as { controlToken?: string | null }).controlToken ?? undefined;
    const initialPrompt = 'ACP_STUB_USAGE_UPDATE=plugin-backed-acp-e2e';
    const spawnRes = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: {
          kind: 'backend',
          backendId,
          configuredBackendId: backendId,
          sourceKind: 'configured',
        },
        terminal: { mode: 'plain' },
        initialPrompt,
        environmentVariables: {
          HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: server.baseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          DEBUG: '1',
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        },
      },
      timeoutMs: 90_000,
    });

    expect(spawnRes.status, JSON.stringify(spawnRes.data, null, 2)).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }
    const activeServer = server;
    if (!activeServer) {
      throw new Error('Missing server handle after startServerLight');
    }

    await waitFor(async () => {
      const snap = await fetchSessionV2(activeServer.baseUrl, auth.token, sessionId);
      const metadata = decryptLegacyBase64Normalized(snap.metadata, secret);
      if (!isRecord(metadata)) return false;
      const acpConfiguredBackend = metadata.acpConfiguredBackendV1;
      if (!isRecord(acpConfiguredBackend)) return false;
      return acpConfiguredBackend.backendId === backendId
        && acpConfiguredBackend.title === 'Plugin Review Bot'
        && metadata.flavor === `acp:${backendId}`;
    }, {
      timeoutMs: 60_000,
      intervalMs: 250,
      context: 'plugin-backed ACP session metadata',
    });

    await waitFor(async () => {
      const rows = await fetchMessagesSince({
        baseUrl: activeServer.baseUrl,
        token: auth.token,
        sessionId,
        afterSeq: 0,
      });

      let sawPrompt = false;
      let sawAcpResponse = false;

      for (const row of rows) {
        const decoded = decryptLegacyBase64Normalized(row.content.c, secret);
        if (!isRecord(decoded)) continue;

        const content = isRecord(decoded.content) ? decoded.content : null;
        if (decoded.role === 'user' && content?.type === 'text' && content.text === initialPrompt) {
          sawPrompt = true;
        }

        if (decoded.role !== 'agent') continue;
        if (content?.type !== 'acp' || content.provider !== `acp:${backendId}`) continue;
        const data = isRecord(content.data) ? content.data : null;
        if (data?.type !== 'message' || typeof data.message !== 'string') continue;
        if (data.message.includes('ACP_STUB_USAGE_UPDATE_DONE plugin-backed-acp-e2e')) {
          sawAcpResponse = true;
        }
      }

      return sawPrompt && sawAcpResponse;
    }, {
      timeoutMs: 90_000,
      intervalMs: 250,
      context: 'plugin-backed ACP transcript markers',
    });
  }, 240_000);
});

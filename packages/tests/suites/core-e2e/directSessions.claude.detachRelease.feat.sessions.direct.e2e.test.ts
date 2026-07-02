import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';

const run = createRunDirs({ runLabel: 'core' });
const daemonStartupTimeoutMs = 90_000;

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('core e2e: direct Claude session detach watcher release', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('does not keep detached attached-only sessions hot after the view lease releases', async () => {
    const testDir = run.testDir('direct-sessions-claude-detach-release');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const claudeConfigDir = resolve(join(testDir, '.claude'));
    const claudeSessionFile = resolve(join(claudeConfigDir, 'projects', 'proj-direct-detach', 'sess-direct-detach.jsonl'));

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(join(claudeConfigDir, 'projects', 'proj-direct-detach'), { recursive: true });
    await writeFile(
      claudeSessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'detach-u1', cwd: '/tmp/direct-detach-project', message: { content: 'detach seed prompt' } }),
        jsonlLine({ type: 'assistant', uuid: 'detach-a1', cwd: '/tmp/direct-detach-project', message: { model: 'claude-test', content: [{ type: 'text', text: 'detach seed reply' }] } }),
      ].join(''),
      'utf8',
    );

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey,
    });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: daemonStartupTimeoutMs,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      },
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for direct session detach release e2e' });

      const machineRpc = createDataKeyRpcClient(ui, machineKey);

      const link = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
        machineId: seeded.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-detach',
        titleHint: 'Detached view lease release fixture',
        directoryHint: '/tmp/direct-detach-project',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-detach' },
      });
      const linkResult = unwrapDataKeyRpcResult(link, 'direct Claude detach release link');
      expect(linkResult).toEqual(expect.objectContaining({
        ok: true,
        created: true,
      }));
      const sessionId = (linkResult as { sessionId: string }).sessionId;

      const attach = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH}`, {
        machineId: seeded.machineId,
        sessionId,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-detach',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-detach' },
        ttlMs: 30_000,
      });
      const attachResult = unwrapDataKeyRpcResult(attach, 'direct Claude attach before detach release');
      expect(attachResult).toEqual(expect.objectContaining({
        ok: true,
        renewed: false,
      }));

      const detach = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH}`, {
        machineId: seeded.machineId,
        sessionId,
        leaseId: (attachResult as { leaseId: string }).leaseId,
      });
      const detachResult = unwrapDataKeyRpcResult(detach, 'direct Claude detach before watcher release assertion');
      expect(detachResult).toEqual(expect.objectContaining({
        ok: true,
        detached: true,
      }));

      await appendFile(
        claudeSessionFile,
        jsonlLine({
          type: 'assistant',
          uuid: 'detach-a2',
          cwd: '/tmp/direct-detach-project',
          message: { model: 'claude-test', content: [{ type: 'text', text: 'detached attached-only delta' }] },
        }),
        'utf8',
      );

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));

      const metadataAfterDetach = await fetchSessionMetadataV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        machineKeys: [machineKey],
      });
      const externalSession = isRecord(metadataAfterDetach.externalSessionV1) ? metadataAfterDetach.externalSessionV1 : null;
      expect(externalSession).toEqual(expect.objectContaining({
        v: 1,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-detach',
      }));
      expect(externalSession).not.toHaveProperty('lastKnownActivityAtMs');
      expect(metadataAfterDetach).not.toHaveProperty('externalSessionAttentionV1');
    } finally {
      ui.close();
    }
  }, 240_000);
});

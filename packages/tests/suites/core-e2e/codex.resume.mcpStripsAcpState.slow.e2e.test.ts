import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Codex MCP attach strips stale ACP session state metadata', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('removes acpSessionModes/models/configOptions metadata when attaching with MCP engine', async () => {
    const testDir = run.testDir('codex-attach-mcp-strips-acp-state');
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
        name: 'codex-attach-mcp-strips-acp-state',
        createdAt: Date.now(),
        flavor: 'codex',
        permissionMode: 'read-only',
        permissionModeUpdatedAt: 10,
        modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'gpt-test' },
        acpSessionModeOverrideV1: { v: 1, updatedAt: 12, modeId: 'plan' },
        // Stale ACP fields (simulates a session previously run under Codex ACP).
        acpSessionModesV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 1,
          currentModeId: 'code',
          availableModes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }],
        },
        acpSessionModelsV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 1,
          currentModelId: 'gpt-test',
          availableModels: [{ id: 'default', name: 'Default' }, { id: 'gpt-test', name: 'gpt-test' }],
        },
        acpConfigOptionsV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 1,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: 'gpt-test',
              options: [{ value: 'gpt-test', name: 'gpt-test' }],
            },
          ],
        },
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-codex-attach-mcp-strips-acp-state-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'codex-attach-mcp-strips-acp-state',
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
      // Ensure MCP engine (no ACP).
      HAPPIER_EXPERIMENTAL_CODEX_ACP: '0',
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
      // Wait for the CLI to attach and publish startup metadata (hostPid is a stable signal).
      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        const meta = decryptLegacyBase64(snap.metadata, secret) as any;
        return typeof meta.hostPid === 'number' && Number.isFinite(meta.hostPid);
      }, { timeoutMs: 45_000 });

      // Verify stale ACP state is removed under MCP attach.
      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        const meta = decryptLegacyBase64(snap.metadata, secret) as any;
        return (
          meta.acpSessionModesV1 === undefined &&
          meta.acpSessionModelsV1 === undefined &&
          meta.acpConfigOptionsV1 === undefined
        );
      }, { timeoutMs: 45_000 });

      const finalSnap = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const finalMeta = decryptLegacyBase64(finalSnap.metadata, secret) as any;
      expect(finalMeta.acpSessionModesV1).toBeUndefined();
      expect(finalMeta.acpSessionModelsV1).toBeUndefined();
      expect(finalMeta.acpConfigOptionsV1).toBeUndefined();
      expect(finalMeta.permissionMode).toBe('read-only');
      expect(finalMeta.permissionModeUpdatedAt).toBeGreaterThanOrEqual(10);
      expect(finalMeta.modelOverrideV1).toEqual({ v: 1, updatedAt: 11, modelId: 'gpt-test' });
      expect(finalMeta.acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 12, modeId: 'plan' });
    } finally {
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});

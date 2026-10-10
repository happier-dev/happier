import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { importSessionHandoffAgentBundle, resolveExistingSessionHandoffState } from './import';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { applyAgentAuthoredSessionStateUpdatesToMetadata } from '@/agent/runtime/state/agentAuthoredSessionStateUpdates';

describe('Codex session handoff production reachability', () => {
  let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

  beforeAll(async () => {
    runtimeFixture = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] },
    });
  });

  afterAll(async () => {
    await runtimeFixture?.dispose();
    runtimeFixture = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads exact admitted native state and rechecks its effective child home before launch without repairing disappearance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-existing-reachability-'));
    const nativeHome = join(root, 'target-home');
    const sqliteHome = join(root, 'target-sqlite');
    await mkdir(nativeHome);
    await mkdir(sqliteHome);
    const nativeSessionId = '  exact/native-thread  ';
    const rolloutPath = join(nativeHome, 'rollout.jsonl');
    const contents = `${JSON.stringify({ type: 'session_meta', payload: { id: nativeSessionId } })}\n`;
    await writeFile(rolloutPath, contents);
    const databasePath = join(sqliteHome, 'state_5.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(nativeSessionId, rolloutPath);
    database.close();
    const metadata = applyAgentAuthoredSessionStateUpdatesToMetadata({ machineId: 'source', path: '/source/repo' }, [
      { fieldId: 'identity.runtimeDescriptor', value: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer', providerSessionId: nativeSessionId, home: 'user', homePath: '/source-only/home' } } },
      { fieldId: 'identity.providerSessionId', value: nativeSessionId },
    ]);
    const childEnvironment = { CODEX_HOME: nativeHome, CODEX_SQLITE_HOME: sqliteHome };
    const before = await readFile(databasePath);
    try {
      await expect(resolveExistingSessionHandoffState({ metadata, targetPath: root,
        environmentVariables: childEnvironment, sessionStorageMode: 'persisted' })).resolves.toMatchObject({
        remoteSessionId: nativeSessionId,
        resume: { directory: root, resume: nativeSessionId, environmentVariables: childEnvironment },
      });
      const launchInput = {
        options: { directory: root, resume: nativeSessionId, handoffStateTransfer: 'existing' as const },
        existingSessionMetadata: metadata,
        // Actual env assembly is the owner under test; profile keys must win over the daemon home.
        profileEnvironmentVariables: childEnvironment,
        daemonSpawnHooks: null, processEnv: { CODEX_HOME: join(root, 'empty-daemon-home') },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      };
      expect(await resolveSpawnChildEnvironment(launchInput)).toMatchObject({ ok: true,
        extraEnvForChild: childEnvironment });
      expect(await readFile(databasePath)).toEqual(before);
      expect(await readFile(rolloutPath, 'utf8')).toBe(contents);
      await rm(rolloutPath);
      expect(await resolveSpawnChildEnvironment(launchInput)).toMatchObject({ ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: expect.stringContaining('existing_session_state_unavailable'),
      });
      expect(await readFile(databasePath)).toEqual(before);
      await expect(readFile(rolloutPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('imports through the generated SessionHostBridge execution surface', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-reachability-'));
    const relativePath = 'sessions/2026/07/23/rollout-thread-reachable.jsonl';
    const content = Buffer.from([
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'thread-reachable' },
      }),
      JSON.stringify({ event: 'reachable' }),
      '',
    ].join('\n'), 'utf8');
    vi.stubEnv('CODEX_HOME', codexHome);

    try {
      await expect(importSessionHandoffAgentBundle({
        targetPath: '/repo',
        bundle: {
          agentId: 'codex',
          remoteSessionId: 'thread-reachable',
          affinity: {
            backendMode: 'appServer',
          },
          files: [{
            relativePath,
            contentBase64: content.toString('base64'),
          }],
        },
      })).resolves.toMatchObject({
        remoteSessionId: 'thread-reachable',
        directSource: {
          kind: 'codexHome',
          home: 'user',
          homePath: codexHome,
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread-reachable',
          },
        },
        resume: {
          directory: '/repo',
          agent: 'codex',
          resume: 'thread-reachable',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
          transcriptStorage: 'direct',
          approvedNewDirectoryCreation: true,
          environmentVariables: {
            CODEX_HOME: codexHome,
          },
        },
      });

      await expect(readFile(join(codexHome, relativePath)))
        .resolves.toEqual(content);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

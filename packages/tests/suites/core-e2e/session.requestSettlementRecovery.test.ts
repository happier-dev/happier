import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { resolveTsxImportHookSpecifier } from '../../src/testkit/process/tsxImportHook';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: durable request settlement recovery', () => {
  let server: StartedServer | null = null;
  afterEach(async () => { await server?.stop(); server = null; });

  it.each(['legacy', 'tokenOnly'] as const)('replays an admitted %s settlement after runtime restart without clearing background or newer requests', async (credentialMode) => {
    const testDir = run.testDir(`request-settlement-${randomUUID()}`);
    const extraEnv = { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only' };
    server = await startServerLight({ testDir, dbProvider: 'sqlite', extraEnv });
    const baseUrl = server.baseUrl;
    const auth = await createTestAuth(baseUrl);
    const requestId = 'foreground-request';
    const request = { tool: 'Write', arguments: { path: '/workspace/private-settlement-marker' }, createdAt: Date.now(), kind: 'permission' };
    const initialState = { requests: { [requestId]: request, background: { ...request, createdAt: request.createdAt + 1 } } };
    const created = await fetchJson<{ session: { id: string } }>(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: randomUUID(), metadata: JSON.stringify({ path: '/workspace', host: 'test-host' }), agentState: JSON.stringify(initialState), dataEncryptionKey: null }),
    });
    expect(created.status).toBe(200);
    const sessionId = created.data.session.id;
    const snapshot = await fetchSessionV2(baseUrl, auth.token, sessionId);
    const homeDir = join(testDir, 'runtime-home');
    await mkdir(homeDir, { recursive: true });
    const secret = [...randomBytes(32)];
    const runtimeSession = {
      id: sessionId, seq: snapshot.seq, encryptionMode: 'plain', metadata: { path: '/workspace', host: 'test-host' },
      metadataVersion: snapshot.metadataVersion, agentState: initialState, agentStateVersion: snapshot.agentStateVersion,
    };
    const launchRuntime = async (phase: 'admit' | 'recover', session: typeof runtimeSession) => {
      const inputPath = join(testDir, `${phase}.json`);
      await writeFile(inputPath, JSON.stringify({ phase, credentialMode, token: auth.token, secret, session, requestId }), { mode: 0o600 });
      const hook = resolveTsxImportHookSpecifier();
      if (!hook) throw new Error('Missing canonical tsx import hook');
      await runLoggedCommand({
        command: process.execPath, args: ['--import', hook, join(repoRootDir(), 'packages/tests/fixtures/request-settlement-runtime.ts'), inputPath],
        cwd: repoRootDir(), env: { ...process.env, HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: baseUrl, TSX_TSCONFIG_PATH: join(repoRootDir(), 'apps/cli/tsconfig.json') },
        stdoutPath: join(testDir, `${phase}.stdout.log`), stderrPath: join(testDir, `${phase}.stderr.log`), timeoutMs: 90_000,
      });
    };
    await server.stop(); server = null;
    await launchRuntime('admit', runtimeSession);
    const journalFiles = (await readdir(homeDir, { recursive: true })).filter((file) => file.endsWith(`session-${sessionId}.json`));
    expect(journalFiles).toHaveLength(1);
    const admitted = await readFile(join(homeDir, journalFiles[0]), 'utf8');
    expect(JSON.parse(admitted)).toMatchObject({
      mutations: expect.arrayContaining([expect.objectContaining({
        kind: 'agent_state_request_settlement',
        payload: expect.objectContaining({ content: expect.objectContaining({
          t: credentialMode === 'tokenOnly' ? 'installation_encrypted_v1' : 'encrypted',
        }) }),
      })]),
    });
    expect(admitted).not.toContain('private-settlement-marker');
    server = await startServerLight({ testDir, dbProvider: 'sqlite', extraEnv, preserveExistingDataDir: true, __portAllocator: async () => Number(new URL(baseUrl).port) });
    const observer = createUserScopedSocketCollector(baseUrl, auth.token);
    observer.connect();
    try {
      await waitFor(() => observer.isConnected(), { timeoutMs: 20_000 });
      const newerState = { ...initialState, requests: { ...initialState.requests, newer: { ...request, createdAt: request.createdAt + 2 } } };
      await expect(observer.emitWithAck('update-state', {
        sid: sessionId, expectedVersion: snapshot.agentStateVersion, agentState: JSON.stringify(newerState),
        activitySummaryV1: { pendingPermissionRequestCount: 3, pendingUserActionRequestCount: 0 },
      })).resolves.toMatchObject({ result: 'success' });
      // Deliberately reconstruct from the older snapshot so the real CAS conflict path must rebase.
      await launchRuntime('recover', runtimeSession);
      const settled = await fetchSessionV2(baseUrl, auth.token, sessionId);
      expect(settled).toMatchObject({ pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 0 });
      const state = JSON.parse(String(settled.agentState));
      expect(Object.keys(state.requests).sort()).toEqual(['background', 'newer']);
      expect(state.completedRequests[requestId].status).toBe(credentialMode === 'tokenOnly' ? 'canceled' : 'approved');
      await waitFor(() => observer.getEvents().some((event) => event.kind === 'update' && event.payload.body?.pendingPermissionRequestCount === 2), { timeoutMs: 20_000 });
    } finally { observer.close(); }
  });
});

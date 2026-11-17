import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { registerSessionRealtimeTranscriptConsumer } from '../../../../apps/ui/sources/sync/runtime/sessionRealtimeTranscriptConsumers';
import { getSyncSingleton } from '../../../../apps/ui/sources/sync/runtime/getSyncSingleton';

import { createMuseMspProcessFixture, MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording, readMuseMspProcessAudit } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { createTestAuth } from '../../src/testkit/auth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { waitForSessionActive } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

// Real UI Action -> Home/Postgres -> daemon/runner -> Muse stdio. The two native
// CLIs are OS boundary substitutes; no internal permission/Run owner is mocked.
it('projects a retained native approval into Run GET and applies the parent decision after native ACK', async () => {
  const testDir = run.testDir(`muse-retained-native-approval-${randomUUID()}`);
  const daemonHome = resolve(testDir, 'daemon-home');
  const capabilitySelection = { mcp: { managedServersEnabled: false, happierToolsEnabled: false,
    forceIncludeServerIds: [], forceExcludeServerIds: [] } };
  const workspace = resolve(testDir, 'workspace');
  const bin = resolve(testDir, 'bin');
  const nativeHome = resolve(testDir, 'native-home');
  await Promise.all([daemonHome, workspace, bin, nativeHome].map(path => mkdir(path, { recursive: true })));
  const auditPath = join(testDir, 'muse-native-audit.json');
  const decisionAckPath = join(testDir, 'release-native-ack');
  // Advanced's approval capture predates its model/list probe. Append the
  // existing login capture's exact response, leaving decision row indices intact.
  const approval = object(JSON.parse(await readFile(resolve(repoRootDir(),
    'packages/plugins/muse/src/agent/testkit/fixtures/advanced.json'), 'utf8')));
  const catalog = object(await readMuseLoginRecording());
  if (!Array.isArray(approval.rows) || !Array.isArray(catalog.rows)) throw new Error('Native capture rows are unavailable');
  const modelRequest = catalog.rows.map(object).find(row => row.direction === 'send'
    && row.message !== null && typeof row.message === 'object' && object(row.message).method === 'model/list');
  if (!modelRequest) throw new Error('Native model/list capture is unavailable');
  const modelResponse = catalog.rows.map(object).find(row => row.direction === 'recv'
    && row.message !== null && typeof row.message === 'object'
    && object(row.message).id === object(modelRequest.message).id);
  if (!modelResponse) throw new Error('Native model/list response capture is unavailable');
  const recordingPath = join(testDir, 'native-approval-with-catalog.json');
  await writeFile(recordingPath, JSON.stringify({ ...approval, rows: [...approval.rows, modelRequest, modelResponse] }));
  const native = await createMuseMspProcessFixture({ scenario: 'approval-abort', recordingPath, auditPath, decisionAckPath, cwd: workspace });
  const executable = await native.resolveExecutable();
  // Catalog-only native probes share the executable, but must not overwrite
  // evidence owned by the retained native Session during concurrent refreshes.
  const playback = MUSE_MSP_PLAYBACK_SCRIPT.replace('if (!process.env.MUSE_TEST_AUDIT_PATH) return;',
    "if (!process.env.MUSE_TEST_AUDIT_PATH || !requests.includes('session/start')) return;");
  await writeFile(join(bin, 'muse'), `#!${process.execPath}
Object.assign(process.env, ${JSON.stringify(executable.env)});
if (process.argv.includes('--version')) { console.log('muse 1.4.14'); } else {
${playback}
}
`, { mode: 0o755 });
  const sourceOptions = [process.env.NODE_OPTIONS, '--import',
    pathToFileURL(resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href,
  ].filter(Boolean).join(' ');
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let releaseSessionConsumer: (() => void) | undefined;
  let journeyFailure: unknown;
  try {
    server = await startServerLight({ testDir, dbProvider: 'postgres', extraEnv: {
      DATABASE_URL: postgres.homeDatabaseUrl,
      NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    const serverUrl = server.baseUrl;
    const auth = await createTestAuth(serverUrl);
    const seeded = await seedCliAuthForTestAccount({ cliHome: daemonHome, serverUrl: serverUrl, auth, mode: 'legacy' });
    await upsertEncryptedAccountSettingsV2({ baseUrl: serverUrl, token: auth.token,
      secret: auth.accountSigningSeed, settings: { claudeUnifiedTerminalEnabled: false,
        claudeRemoteAgentSdkEnabled: true, claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] } });
    const environment = {
      CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHome, HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: serverUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), HAPPIER_E2E_FAKE_CLAUDE_LOG: join(testDir, 'claude.jsonl'),
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      NODE_OPTIONS: sourceOptions,
      ...executable.env, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), MUSE_INSTALL_DIR: bin,
      HOME: nativeHome, XDG_CONFIG_HOME: join(nativeHome, 'config'), XDG_DATA_HOME: join(nativeHome, 'data'),
      XDG_CACHE_HOME: join(nativeHome, 'cache'), CODEX_HOME: join(nativeHome, 'codex'),
    };
    daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHome, env: { ...process.env, ...environment } });
    ui = await connectUiPersonActionClient({ serverUrl: serverUrl, accountSecret: auth.accountSigningSeed });
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineControlReady(seeded.machineId), { timeoutMs: 60_000 });
    const spawned = await daemonControlPostJson<{ success: boolean; sessionId?: string; error?: string; errorCode?: string }>({
      port: daemon.state.httpPort, controlToken: daemon.state.controlToken, path: '/spawn-session',
      body: { directory: workspace, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' }, environmentVariables: environment, capabilitySelection },
    });
    expect(spawned.status, JSON.stringify({ error: spawned.data.error, errorCode: spawned.data.errorCode })).toBe(200);
    expect(spawned.data.success).toBe(true);
    const sessionId = spawned.data.sessionId;
    if (!sessionId) throw new Error('Parent Session did not start');
    await waitForSessionActive({ baseUrl: serverUrl, token: auth.token, sessionId, timeoutMs: 60_000 });
    // The person opens the parent Session before delegating. This is the real
    // pane lifetime that admits pushed full-content updates into UI storage.
    releaseSessionConsumer = registerSessionRealtimeTranscriptConsumer(sessionId, ui.serverId);
    await getSyncSingleton().ensureSessionVisibleForMessageRoute(sessionId, { serverId: ui.serverId });
    getSyncSingleton().onSessionVisible(sessionId);
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      serverId: ui.serverId, defaultSessionId: sessionId, actionCaller: { kind: 'host' as const } };
    const started = await ui.execute('execution.run.start', {
      sessionId, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'muse' },
      instructions: 'Request the recorded native permission.', permissionMode: 'default',
      modelId: 'meta/muse-spark-1.2', connectedServices: 'native',
      capabilitySelection,
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
    }, context);
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    if (!started.ok) throw new Error(`Run start failed: ${JSON.stringify(started)}`);
    const { runId } = ExecutionRunStartResponseSchema.parse(started.result);
    const readRun = async () => {
      const result = await ui!.execute('execution.run.get', { sessionId, runId }, context);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`Run GET failed: ${JSON.stringify(result)}`);
      return ExecutionRunGetResponseSchema.parse(result.result).run;
    };
    // A provider startup failure is observable here instead of being mistaken
    // for an absent permission request or expected projection failure.
    await waitFor(async () => {
      const current = await readRun();
      if (current.status !== 'running') throw new Error(`Native Run startup failed: ${JSON.stringify(current.error)}`);
      return readMuseMspProcessAudit(auditPath).then(audit => audit.nativeResponseCount > 0, () => false);
    }, { timeoutMs: 60_000, failFast: true });
    // The required Run contract is checked directly after the native receipt;
    // optional parent UI observation cannot hide a broken attention producer.
    await waitFor(async () => {
      expect((await readRun()).attention).toMatchObject({ kind: 'permission_required' });
      return true;
    }, { timeoutMs: 60_000 });
    const status = await ui.execute('session.status.get', { sessionId }, context);
    expect(status, JSON.stringify(status)).toMatchObject({ ok: true });
    let pending: Record<string, unknown> | undefined;
    let requestId: string | undefined;
    await waitFor(async () => {
      const state = ui!.readSessionAgentState(sessionId);
      if (!state) return false;
      const agentState = object(state);
      const entry = Object.entries(object(agentState.requests ?? {})).find(([, value]) => object(value).kind === 'permission'
        && object(object(value).nativeChoices ?? {}).source === 'muse');
      requestId = entry?.[0];
      pending = entry ? object(entry[1]) : undefined;
      return Boolean(pending);
    }, { timeoutMs: 60_000 });
    if (!requestId || !pending) throw new Error('Muse permission was not projected into the parent Session');
    const nativeChoices = object(pending.nativeChoices);
    const current = await readRun();
    expect(current.attention)
      .toMatchObject({ kind: 'permission_required', requestIds: [requestId], requests: [{ requestId, createdAt: pending.createdAt, nativeChoices }] });
    expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 0, released: false });
    let answered = false;
    const application = ui.executeConfirmed('session.permission.respond', {
      sessionId, requestId, ...(typeof pending.turnId === 'string' ? { turnId: pending.turnId } : {}),
      nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: 'abort' },
    }, context).then(result => { answered = true; return result; });
    await Promise.race([
      waitFor(async () => (await readMuseMspProcessAudit(auditPath)).decisionAckPending, { timeoutMs: 60_000 }),
      application.then(result => { throw new Error(`Permission Action settled before native ACK: ${JSON.stringify(result)}`); }),
    ]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    const heldState = object(ui.readSessionAgentState(sessionId));
    expect(object(heldState.requests ?? {})[requestId]).toBeDefined();
    expect(object(heldState.completedRequests ?? {})[requestId]).toBeUndefined();
    await writeFile(decisionAckPath + '.complete', 'release');
    await rename(decisionAckPath + '.complete', decisionAckPath);
    expect(await application).toMatchObject({ ok: true });
    await waitFor(async () => {
      expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 1, released: true });
      return true;
    }, { timeoutMs: 60_000 });
    await waitFor(async () => {
      const finalState = object(ui!.readSessionAgentState(sessionId));
      expect(object(finalState.requests ?? {})[requestId!]).toBeUndefined();
      expect(object(finalState.completedRequests ?? {})[requestId!]).toMatchObject({ decision: 'abort',
        permissionDecisionActorV1: { kind: 'accountUser', relationship: 'owner' },
        nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: 'abort' } });
      expect((await readRun()).attention).toBeUndefined();
      return true;
    }, { timeoutMs: 60_000 });
  } catch (error) {
    journeyFailure = error;
    throw error;
  } finally {
    releaseSessionConsumer?.();
    const failures: unknown[] = [];
    for (const cleanup of [() => ui?.close(), () => daemon?.stop(), () => server?.stop(), () => postgres.stop()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      if (journeyFailure) console.error('J3 cleanup failures', failures.map(error =>
        error instanceof Error ? error.message : String(error)));
      else throw new AggregateError(failures, `J3 journey cleanup failed: ${failures.map(error =>
        error instanceof Error ? error.message : String(error)).join('; ')}`);
    }
  }
}, 0);

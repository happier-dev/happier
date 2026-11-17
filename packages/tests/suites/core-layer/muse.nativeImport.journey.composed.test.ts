import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { ExternalSessionsCandidatesListResponseSchema, ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionMaterializeActionResultV1Schema, ExternalSessionOperationActionResultV1Schema,
  type ExternalSessionOperationSharedPresentationV1, type ActionId } from '@happier-dev/protocol';
import { storage } from '../../../../apps/ui/sources/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '../../../../apps/ui/sources/sync/domains/session/readSessionOwnerMetadataView';
import { readExternalSessionLink } from '../../../../apps/ui/sources/sync/domains/session/external/readExternalSessionLink';
import { readExternalSessionOperationPresentationFromMetadata } from '../../../../apps/ui/sources/components/sessions/transcript/items/externalSessionOperationMetadata';
import { registerSessionRealtimeTranscriptConsumer } from '../../../../apps/ui/sources/sync/runtime/sessionRealtimeTranscriptConsumers';
import { createMuseMspProcessFixture, MUSE_MSP_PLAYBACK_SCRIPT } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { readMuseRecord } from '../../../plugins/muse/src/agent/events';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

/** The parked native process acknowledges arrival through its OS boundary. */
async function nativeReadEntered(path: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => { void check(); });
    const close = () => { watcher.close(); signal.removeEventListener('abort', abort); };
    const abort = () => { close(); reject(signal.reason); };
    const check = async () => {
      try { await readFile(path); close(); resolve(); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { close(); reject(error); } }
    };
    watcher.on('error', error => { close(); reject(error); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else void check();
  });
}

// Full source-driven UI Action -> Home/Postgres -> daemon -> native stdio journey.
// Only the vendor-native executable is replaced. The fixture uses captured MSP
// history and a schema-derived second identity, with a held native history read.
it('J5: browses Muse history, imports with progress, cancels another import and archives', async () => {
  const testDir = run.testDir(`muse-native-import-${randomUUID()}`);
  const daemonHome = resolve(testDir, 'daemon-home');
  const nativeHome = resolve(testDir, 'native-home');
  const bin = resolve(testDir, 'bin');
  await Promise.all([daemonHome, nativeHome, bin].map(path => mkdir(path, { recursive: true })));
  const historyPath = resolve(repoRootDir(), 'packages/plugins/muse/src/agent/testkit/fixtures/history.json');
  const listPath = resolve(repoRootDir(), 'packages/plugins/muse/src/agent/testkit/fixtures/isolated-long-history-reopen.json.gz');
  const history = readMuseRecord(JSON.parse((await readFile(historyPath, 'utf8')).replaceAll('[TEMP]/history', nativeHome)));
  const list = readMuseRecord(JSON.parse(gunzipSync(await readFile(listPath)).toString('utf8')));
  if (!Array.isArray(history.rows) || !Array.isArray(list.rows)) throw new Error('Captured MSP history is missing');
  const readResult = readMuseRecord(readMuseRecord(history.rows[36]).message).result;
  const session = readMuseRecord(readMuseRecord(readResult).session);
  if (typeof session.sessionId !== 'string') throw new Error('Captured native Session identity is missing');
  const firstNativeId = session.sessionId;
  const secondNativeId = randomUUID();
  const listRequest = readMuseRecord(list.rows[3]);
  const listResponse = readMuseRecord(list.rows[4]);
  const listMessage = readMuseRecord(listResponse.message);
  const listResult = readMuseRecord(listMessage.result);
  // Preserve captured history Items and cursors. Native list/read responses
  // differ only by the second Session identity; production builds both links.
  const recording = { rows: [history.rows[0], history.rows[1], history.rows[2],
    listRequest, { ...listResponse, message: { ...listMessage, result: { ...listResult,
      sessions: [session, { ...session, sessionId: secondNativeId, title: 'Cancellation candidate' }] } } },
    history.rows[35], history.rows[36], history.rows[51], { ...readMuseRecord(history.rows[52]), message: {
      ...readMuseRecord(readMuseRecord(history.rows[52]).message), result: { events: [], nextCursor: null },
    } }] };
  const recordingPath = join(testDir, 'native-history.json');
  const parkedPath = join(testDir, 'native-read-entered');
  const releasePath = join(testDir, 'native-read-release');
  await writeFile(recordingPath, JSON.stringify(recording));
  const native = await createMuseMspProcessFixture({ recordingPath });
  const executable = await native.resolveExecutable();
  const nativeScript = join(bin, 'muse-playback.cjs');
  // This is entirely on the vendor side: correlate the response identity and
  // hold the second Session's forward read until Cancel has reached the host.
  const boundary = `
const fsBoundary = require('node:fs');
const readlineBoundary = require('node:readline');
const makeInterface = readlineBoundary.createInterface;
let selectedNativeId;
readlineBoundary.createInterface = (...args) => {
  const stream = makeInterface(...args);
  const subscribe = stream.on.bind(stream);
  stream.on = (event, listener) => subscribe(event, event === 'line' ? line => {
    const request = JSON.parse(line);
    // Freeze this captured Session at its final recorded tail. Forward reads
    // have no new events; a latest-tail probe returns that exact captured event.
    if (request.method === 'view/page' && request.params.direction === 'backward') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: ${JSON.stringify(readMuseRecord(readMuseRecord(history.rows[52]).message).result)} }) + '\\n');
      return;
    }
    if (request.method === 'session/read') {
      selectedNativeId = request.params.sessionId;
    }
    if (request.method === 'view/page' && request.params.sessionId === ${JSON.stringify(secondNativeId)}
      && request.params.direction === 'forward') {
      fsBoundary.writeFileSync(${JSON.stringify(parkedPath)}, 'entered');
      let resumed = false;
      const waiter = fsBoundary.watch(${JSON.stringify(testDir)}, () => resume());
      const resume = () => {
        if (resumed || !fsBoundary.existsSync(${JSON.stringify(releasePath)})) return;
        resumed = true;
        waiter.close();
        listener(line);
      };
      resume();
      return;
    }
    listener(line);
  } : listener);
  return stream;
};
const writeBoundary = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => writeBoundary(selectedNativeId
  ? String(chunk).replaceAll(${JSON.stringify(firstNativeId)}, selectedNativeId) : chunk, ...args);
`;
  await writeFile(nativeScript, `Object.assign(process.env, ${JSON.stringify(executable.env)});\nif (process.argv.includes('--version')) console.log('muse 1.4.14'); else {\n${boundary}\n${MUSE_MSP_PLAYBACK_SCRIPT}\n}`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(bin, process.platform === 'win32' ? 'muse.cmd' : 'muse'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${nativeScript}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeScript)} "$@"\n`, { mode: 0o755 });
  const sourceOptions = [process.env.NODE_OPTIONS, '--import',
    pathToFileURL(resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  const database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  const server = await startServerLight({ testDir, dbProvider: 'postgres', extraEnv: {
    DATABASE_URL: database.homeDatabaseUrl,
    NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
  } }).catch(async error => { await database.stop(); throw error; });
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let unsubscribeProgress: (() => void) | undefined;
  let releaseSessionConsumer: (() => void) | undefined;
  const lifetime = new AbortController();
  try {
    const auth = await createTestAuth(server.baseUrl);
    const seeded = await seedCliAuthForTestAccount({ cliHome: daemonHome, serverUrl: server.baseUrl, auth, mode: 'legacy' });
    daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHome, env: { ...process.env,
      CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      NODE_OPTIONS: sourceOptions, ...executable.env, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), MUSE_INSTALL_DIR: bin,
      [resolveAgentCliOverrideEnvKey('muse')]: join(bin, process.platform === 'win32' ? 'muse.cmd' : 'muse'),
      HOME: nativeHome, XDG_CONFIG_HOME: join(nativeHome, 'config'), XDG_DATA_HOME: join(nativeHome, 'data'),
      XDG_CACHE_HOME: join(nativeHome, 'cache'),
    } });
    ui = await connectUiPersonActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
    const { sync } = await import('../../../../apps/ui/sources/sync/sync');
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineControlReady(seeded.machineId), { timeoutMs: 60_000 });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: ui.serverId,
      actionCaller: { kind: 'host' as const } };
    const progressEvents: ExternalSessionOperationSharedPresentationV1[] = [];
    unsubscribeProgress = storage.subscribe(state => {
      for (const sessionId of Object.keys(state.sessions)) {
        const row = state.sessions[sessionId];
        const presentation = readExternalSessionOperationPresentationFromMetadata(row.metadata);
        if (presentation) progressEvents.push(presentation);
      }
    });
    const action = async (id: ActionId, input: unknown) => {
      const result = await ui!.executeConfirmed(id, input, context);
      if (!result.ok) throw new Error(`J5 ${id} refused: ${JSON.stringify(result)}`);
      return result.result;
    };
    const target = { machineId: seeded.machineId, agentId: 'muse', source: { kind: 'museNative' } };
    const candidates = ExternalSessionsCandidatesListResponseSchema.parse(await action('sessions.external.candidates.list', target));
    if (!candidates.ok) throw new Error(`Browse refused: ${JSON.stringify(candidates)}`);
    expect(candidates.candidates.map(row => row.remoteSessionId)).toEqual(expect.arrayContaining([firstNativeId, secondNativeId]));
    const link = async (remoteSessionId: string) => {
      const candidate = candidates.candidates.find(row => row.remoteSessionId === remoteSessionId);
      if (!candidate) throw new Error('Native Browse candidate missing');
      const linked = ExternalSessionLinkEnsureResponseSchema.parse(await action('sessions.external.link.ensure', {
        ...target, remoteSessionId, linkData: candidate.linkData,
      }));
      if (!linked.ok) throw new Error(`Link refused: ${JSON.stringify(linked)}`);
      // Browse opens the linked Session; the canonical route hydration loads
      // its owner metadata before the Session's Import control is available.
      releaseSessionConsumer?.();
      releaseSessionConsumer = registerSessionRealtimeTranscriptConsumer(linked.sessionId, ui!.serverId);
      await sync.ensureSessionVisibleForMessageRoute(linked.sessionId, { serverId: ui!.serverId });
      sync.onSessionVisible(linked.sessionId);
      await waitFor(() => {
        const row = storage.getState().sessions[linked.sessionId];
        return row ? readExternalSessionLink(readSessionOwnerMetadataView(row))?.remoteSessionId === remoteSessionId : false;
      }, { timeoutMs: 60_000 });
      return linked.sessionId;
    };
    const start = async (sessionId: string) => {
      const result = ExternalSessionMaterializeActionResultV1Schema.parse(await action('sessions.external.materialize.start', {
        request: { v: 1, idempotencyKey: randomUUID(), sessionId,
          plan: 'materialize', targetStorageMode: 'external-linked', targetRuntimeMode: null },
      }));
      if (!result.ok) throw new Error(`Import refused: ${JSON.stringify(result)}`);
      return result.operation;
    };
    const sessionId = await link(firstNativeId);
    const first = await start(sessionId);
    await waitFor(() => progressEvents.some(progress => progress.operationId === first.operationId && progress.status === 'completed'), { timeoutMs: 60_000 });
    expect(progressEvents).toContainEqual(expect.objectContaining({ operationId: first.operationId, status: 'running' }));
    expect(progressEvents).toContainEqual(expect.objectContaining({ operationId: first.operationId, status: 'completed' }));
    const imported = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    expect(imported.length).toBeGreaterThan(0);
    const cancelledSessionId = await link(secondNativeId);
    const second = await start(cancelledSessionId);
    await nativeReadEntered(parkedPath, lifetime.signal);
    expect(await fetchAllMessages(server.baseUrl, auth.token, cancelledSessionId)).toEqual([]);
    const cancelled = ExternalSessionOperationActionResultV1Schema.parse(await action('sessions.external.operation.cancel', {
      ...second,
    }));
    if (!cancelled.ok) throw new Error(`Cancel refused: ${JSON.stringify(cancelled)}`);
    // The import owner observes Stop at the next completed source-page boundary.
    // Let the native read finish; cancellation must prevent its rows being staged.
    await writeFile(releasePath, 'released');
    await waitFor(() => progressEvents.some(progress => progress.operationId === second.operationId && progress.status === 'cancelled'), {
      timeoutMs: 60_000, context: 'cancelled native import presentation',
    });
    expect(await fetchAllMessages(server.baseUrl, auth.token, cancelledSessionId)).toEqual([]);
    await action('session.archive', { sessionId });
    expect((await fetchSessionV2(server.baseUrl, auth.token, sessionId)).archivedAt).toEqual(expect.any(Number));
    expect((await fetchAllMessages(server.baseUrl, auth.token, sessionId)).map(row => row.id)).toEqual(imported.map(row => row.id));
  } finally {
    lifetime.abort();
    unsubscribeProgress?.();
    releaseSessionConsumer?.();
    const failures: unknown[] = [];
    for (const cleanup of [() => ui?.close(), () => daemon?.stop(), () => server.stop(), () => database.stop()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'J5 native import cleanup failed');
  }
}, 0);

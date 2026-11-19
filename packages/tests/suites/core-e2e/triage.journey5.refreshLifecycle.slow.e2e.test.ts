/*
 * QB-21 QB-24 QB-27 QB-49 QB-85
 * Journey 5: refresh/reobserve lifecycle settles through typed outcomes.
 * Empty selections stay typed. A populated internal Task window then uses
 * the same Account Actions and canonical projection store through executable
 * retirement and reconnection; no provider response or store result is mocked.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions';
import { InternalTaskMutationOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from '../../../plugins/triage/src/actions/listEntriesProtocol';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryResultV1Schema } from '../../../plugins/triage/src/actions/reobserveEntryProtocol';
import { createTriageListWindowStore } from '../../../plugins/triage/src/projection/listWindowStore';
import { TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../../plugins/triage/src/projection/listWindow';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-journey5' });

it('QB-21 QB-24 QB-27 QB-49 QB-85 keeps empty reads typed and retains populated Tasks through Account read failure and recovery', async () => {
  const testDir = run.testDir(`refresh-${randomUUID()}`);
  const sourceRuntime = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  const server = await startServerLight({ testDir, extraEnv: {
    NODE_OPTIONS: sourceRuntime, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
  } });
  const auth = await createTestAuth(server.baseUrl);
  const homeDir = join(testDir, 'daemon-home');
  await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
  const daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
    ...process.env, NODE_OPTIONS: sourceRuntime, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
  } });
  let client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
  let clientOpen = true;
  const context = { surface: 'ui' as const, authority: 'present_user' as const,
    actionCaller: { kind: 'host' as const }, serverId: client.serverId };
  const invokeRaw = (localId: string, input: unknown) => client.execute('action.invoke', {
    action: { pluginId: 'happier.triage', localId }, input,
  }, context);
  const invoke = async (localId: string, input: unknown) => {
    const result = await invokeRaw(localId, input);
    expect(result, `Triage Action ${localId} result: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Triage Action ${localId} refused (${result.errorCode})`);
    return result.result;
  };
  try {
    await waitFor(() => client.isAccountReady(), { timeoutMs: 60_000 });
    const [first, second] = await Promise.all([
      invokeRaw(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, sources: { kind: 'selected', sourceInstances: [] }, limit: 1, order: 'newest' }),
      invokeRaw(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, sources: { kind: 'selected', sourceInstances: [] }, limit: 1, order: 'newest' }),
    ]);
    for (const result of [first, second]) {
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`Empty selection refused (${result.errorCode})`);
      // No lane was asked: the canonical fold deliberately withholds an
      // authoritative complete census even though this selection has no rows.
      expect(TriageListEntriesResultV1Schema.parse(result.result)).toMatchObject({
        window: { rows: [], lanes: [], coverage: 'partial' },
      });
    }
    const reobserved = await invoke(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, {
      v: 1, sourceInstanceId: '00000000-0000-4000-8000-000000000027',
      entryRef: { source: { pluginId: 'happier.scm.forge.github', localId: 'github-forge' }, kindId: 'issue', collisionScope: 'github:journey5', entryId: '27' },
    });
    expect(TriageReobserveEntryResultV1Schema.parse(reobserved)).toMatchObject({ kind: 'unavailable' });

    const createTask = async (title: string) => {
      const result = await client.executeConfirmed('tasks.internal.create', { fields: { title } }, context);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`Task creation refused (${result.errorCode})`);
      const created = InternalTaskMutationOutputSchema.parse(result.result);
      expect(created.status).toBe('applied');
      if (created.status !== 'applied') throw new Error('Task creation was not applied');
      return created.todo.id;
    };
    const firstTitle = `First lifecycle task ${randomUUID()}`;
    const secondTitle = `Second lifecycle task ${randomUUID()}`;
    const firstId = await createTask(firstTitle);
    const secondId = await createTask(secondTitle);
    const taskIds = [firstId, secondId].sort();
    const refusedReads: ActionExecuteFailure[] = [];
    let listReads = 0;
    const store = createTriageListWindowStore({
      nowMs: Date.now,
      async readEntries(input) {
        listReads += 1;
        const result = await invokeRaw(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, input);
        if (!result.ok) {
          // The real Action boundary supplies the refusal; the adapter carries
          // its original typed code to the same store used by mounted surfaces.
          const refusal = ActionExecuteFailureSchema.parse(result);
          refusedReads.push(refusal);
          throw new PluginError({ code: refusal.errorCode, message: refusal.error });
        }
        return TriageListEntriesResultV1Schema.parse(result.result);
      },
    });
    const snapshots: ReturnType<typeof store.getSnapshot>[] = [];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
    const visibleTaskIds = () => store.getSnapshot().window?.rows.map(row => row.entryRef.entryId).sort();
    try {
      expect(store.getSnapshot()).toMatchObject({ freshness: 'unknown', pending: 'idle' });
      expect(store.getSnapshot().window).toBeUndefined();

      // The positive control reaches actual Account storage before the
      // executable lifecycle is changed. A refusal cannot stand in for it.
      await store.refresh('view');
      expect(store.getSnapshot()).toMatchObject({ freshness: 'fresh', pending: 'idle' });
      expect(store.getSnapshot().error).toBeUndefined();
      expect(visibleTaskIds()).toEqual(taskIds);
      const readSourceIds = store.getSnapshot().window!.lanes.map(lane => lane.sourceInstanceId).sort();
      expect(readSourceIds.length).toBeGreaterThan(0);
      expect(snapshots.some(snapshot => snapshot.pending === 'initial'
        && snapshot.freshness === 'unknown' && snapshot.window === undefined)).toBe(true);

      // close() invalidates the real portable Account executable and withdraws
      // its UI connection. The server and the daemon remain running.
      await client.close();
      clientOpen = false;
      await store.refresh('manual');
      expect(refusedReads.length).toBeGreaterThan(0);
      expect(store.getSnapshot()).toMatchObject({ freshness: 'stale', pending: 'idle' });
      expect(store.getSnapshot().error).toBeUndefined();
      expect(store.getSnapshot().unreadableSources?.map(source => source.sourceInstanceId).sort()).toEqual(readSourceIds);
      expect(visibleTaskIds()).toEqual(taskIds);
      expect(snapshots.some(snapshot => snapshot.pending === 'refresh'
        && snapshot.window?.rows.length === taskIds.length)).toBe(true);

      // Reconnect the same persisted Account and notify the window's existing
      // transport-replacement owner, then join its queued recovery demand.
      client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
      clientOpen = true;
      await waitFor(() => client.isAccountReady(), { context: 'QB-85 reconnected Account readiness' });
      store.replaceReadTransport();
      await store.refresh('view');
      expect(store.getSnapshot()).toMatchObject({ freshness: 'fresh', pending: 'idle' });
      expect(store.getSnapshot().error).toBeUndefined();
      expect(store.getSnapshot().unreadableSources).toBeUndefined();
      expect(visibleTaskIds()).toEqual(taskIds);

      // Search reprojects the retained acquisition. Switching between disjoint
      // lenses replaces the visible membership and issues no Action read.
      const readsBeforeLensChange = listReads;
      store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: firstTitle });
      expect(visibleTaskIds()).toEqual([firstId]);
      store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: secondTitle });
      expect(visibleTaskIds()).toEqual([secondId]);
      store.setLens({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: `Absent lifecycle task ${randomUUID()}` });
      expect(visibleTaskIds()).toEqual([]);
      store.setLens(TRIAGE_LIST_DEFAULT_LENS_V1);
      expect(visibleTaskIds()).toEqual(taskIds);
      expect(store.getSnapshot().freshness).toBe('fresh');
      expect(listReads).toBe(readsBeforeLensChange);
    } finally {
      unsubscribe();
      store.dispose();
    }

  } finally {
    if (clientOpen) await client.close();
    await daemon.stop(); await server.stop();
  }
}, 0);

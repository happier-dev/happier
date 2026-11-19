// QB-74
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import {
  TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
  TriageAdministerSavedViewResultV1Schema,
  TriageReadSavedViewsResultV1Schema,
} from '../../../plugins/triage/src/actions/savedViewsProtocol';
import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../../../plugins/triage/src/corpus/query/smartPolicy';
import { resolveTriageEffectiveView } from '../../../plugins/triage/src/settings/effectiveView';
import { TRIAGE_LIST_NO_FILTERS_V1, type SurfaceFilterSelectionV1 } from '../../../plugins/triage/src/projection/listWindow';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-saved-views-journey' });

describe('core e2e: Triage saved views through the Account Action', () => {
  let server: Awaited<ReturnType<typeof startServerLight>>;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let clientA: Awaited<ReturnType<typeof connectUiTriageActionClient>>;
  let clientB: Awaited<ReturnType<typeof connectUiTriageActionClient>>;
  let accountSecret: Uint8Array;
  let machineId: string;

  beforeAll(async () => {
    const testDir = run.testDir(`saved-views-${randomUUID()}`);
    const sourceRuntime = pathToFileURL(join(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href;
    const nodeOptions = [process.env.NODE_OPTIONS, '--import', sourceRuntime].filter(Boolean).join(' ');
    server = await startServerLight({ testDir, extraEnv: {
      NODE_OPTIONS: nodeOptions,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    const auth = await createTestAuth(server.baseUrl);
    accountSecret = auth.accountSigningSeed;
    const homeDir = join(testDir, 'daemon-home');
    await mkdir(homeDir, { recursive: true });
    const seeded = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
    machineId = seeded.machineId;
    daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
      ...process.env, NODE_OPTIONS: nodeOptions, CI: '1', HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    } });
  }, 0);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const close of [() => clientB?.close(), () => clientA?.close(), () => daemon?.stop(), () => server?.stop()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Saved-view journey cleanup failed');
  }, 120_000);

  it('creates, edits, selects/resets, and CAS-conflicts saved effective views', async ({ onTestFailed, signal }) => {
    let pendingBoundary = 'connect first Triage Account client';
    onTestFailed(() => {
      // A timeout must identify the awaited real boundary, without serializing
      // credentials or the person's stored views after the test has finished.
      console.error(JSON.stringify({ boundary: 'saved-views-journey', pendingBoundary,
        accountReadyA: clientA?.isAccountReady(), accountReadyB: clientB?.isAccountReady(),
        machineControlReady: clientA?.isMachineControlReady(machineId) }));
    });
    clientA = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret });
    pendingBoundary = 'first client Account and Machine readiness';
    await waitFor(() => clientA.isAccountReady() && clientA.isMachineControlReady(machineId), {
      timeoutMs: 60_000, context: 'saved-view Account and Machine readiness',
    });
    const context = (client: typeof clientA) => ({ surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId: client.serverId, signal });
    const invoke = async (client: typeof clientA, localId: string, input: unknown) => {
      pendingBoundary = `${client === clientA ? 'first' : 'second'} client Action ${localId}`;
      const result = await client.executeConfirmed('action.invoke', { action: { pluginId: 'happier.triage', localId }, input }, context(client));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`${localId} refused (${result.errorCode})`);
      return result.result;
    };
    const read = async (client: typeof clientA) => TriageReadSavedViewsResultV1Schema.parse(
      await invoke(client, TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1, { v: 1 }));
    const write = async (client: typeof clientA, input: unknown) => TriageAdministerSavedViewResultV1Schema.parse(
      await invoke(client, TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, input));
    const sourceNeutralFacetValues: SurfaceFilterSelectionV1['sources'] = Array.from({ length: 17 }, (_, index) => ({
      source: { pluginId: 'fixture.source', localId: `source-${index}` }, sourceInstanceId: randomUUID(),
    }));
    const initial = await read(clientA);
    expect(initial).toMatchObject({ availability: 'absent', views: [], revision: 'absent' });
    const draft = { label: `Inbox ${randomUUID()}`, query: 'needs review',
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: sourceNeutralFacetValues },
      order: 'smart' as const, smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1, view: 'list' as const };
    const created = await write(clientA, { v: 1, kind: 'create', expectedRevision: initial.revision, ...draft });
    expect(created).toMatchObject({ status: 'applied', viewId: expect.any(String), revision: expect.any(String), views: [draft] });
    if (created.status !== 'applied' || !created.viewId || !created.revision) throw new Error('Saved-view create did not apply');
    const createdId = created.viewId;
    const createdRevision = created.revision;
    expect((await read(clientA)).views).toEqual(created.views);
    expect(resolveTriageEffectiveView({ saved: { kind: 'parsed', value: { v: 1, views: created.views! } },
      selectedViewId: createdId, configuredSources: [] })).toMatchObject({ availability: 'saved', viewId: createdId,
      query: draft.query, order: draft.order, smartPolicy: draft.smartPolicy });
    pendingBoundary = 'connect second Triage Account client';
    clientB = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret });
    const secondClientBaseline = await read(clientB);
    expect(secondClientBaseline.revision).toBe(createdRevision);
    const edited = { ...draft, label: `${draft.label} edited`, query: 'awaiting response', order: 'oldest' as const, view: 'board' as const };
    const updated = await write(clientA, { v: 1, kind: 'update', viewId: createdId, expectedRevision: createdRevision, ...edited });
    expect(updated).toMatchObject({ status: 'applied', viewId: createdId, views: [edited] });
    if (updated.status !== 'applied' || !updated.revision) throw new Error('Saved-view update did not apply');
    const stale = await write(clientB, { v: 1, kind: 'update', viewId: createdId, expectedRevision: secondClientBaseline.revision,
      ...{ ...edited, label: `${edited.label} stale` } });
    expect(stale).toEqual({ v: 1, status: 'conflict' });
    expect((await read(clientA)).views).toEqual(updated.views);
    const deleted = await write(clientA, { v: 1, kind: 'delete', viewId: createdId, expectedRevision: updated.revision });
    expect(deleted).toMatchObject({ status: 'applied', views: [], revision: expect.any(String) });
    expect((await read(clientA)).views).toEqual([]);
    expect(resolveTriageEffectiveView({ saved: { kind: 'parsed', value: { v: 1, views: [] } },
      selectedViewId: createdId, configuredSources: [] })).toMatchObject({ availability: 'unsavedDefault', viewId: null,
      query: '', order: 'newest' });
    pendingBoundary = 'complete';
  }, 240_000);
});

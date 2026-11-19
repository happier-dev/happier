/*
 * QB-25 QB-28 QB-36 QB-85
 * Journey 4: durable pins and cross-client currentness.
 * The composed path uses a native UI Account executable and server/Postgres.
 * The daemon restarts and then stops before the retained pin is read.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { InternalTaskMutationOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from '../../../plugins/triage/src/actions/listEntriesProtocol';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TriageListPinnedEntriesResultV1Schema,
  TriageSetEntryPinnedResultV1Schema,
} from '../../../plugins/triage/src/actions/userMarksProtocol';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-journey4' });

it('keeps pins across fresh clients and daemon restart, and reads them with the daemon stopped', async () => {
  const testDir = run.testDir(`pins-${randomUUID()}`);
  const sourceRuntime = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  const server = await startServerLight({ testDir, extraEnv: {
    NODE_OPTIONS: sourceRuntime,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
  } });
  const auth = await createTestAuth(server.baseUrl);
  const homeDir = join(testDir, 'daemon-home');
  await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
  const daemonParams = { testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
    ...process.env, NODE_OPTIONS: sourceRuntime, CI: '1', HAPPIER_VARIANT: 'dev',
    HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl,
    HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
  } };
  let daemon = await startTestDaemon(daemonParams);
  const first = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
  const second = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
  const clients = [first, second];
  const context = (client: typeof first) => ({ surface: 'ui' as const, authority: 'present_user' as const,
    actionCaller: { kind: 'host' as const }, serverId: client.serverId });
  const invoke = async (client: typeof first, localId: string, input: unknown) => {
    const result = await client.execute('action.invoke', { action: { pluginId: 'happier.triage', localId }, input }, context(client));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Triage Action ${localId} refused (${result.errorCode})`);
    return result.result;
  };
  try {
    await waitFor(() => first.isAccountReady() && second.isAccountReady(), { timeoutMs: 60_000 });
    const created = await first.executeConfirmed('tasks.internal.create', {
      fields: { title: `Cross-client pin ${randomUUID()}` },
    }, context(first));
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(`Pin Task creation refused (${created.errorCode})`);
    const task = InternalTaskMutationOutputSchema.parse(created.result);
    expect(task.status).toBe('applied');
    if (task.status !== 'applied') throw new Error('Pin Task was not created');
    const materialized = TriageListEntriesResultV1Schema.parse(await invoke(first,
      TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, sources: { kind: 'allConfigured' }, limit: 1, order: 'newest' }));
    const row = materialized.window.rows.find(candidate => candidate.entryRef.entryId === task.todo.id);
    expect(row?.observation?.outcome.kind).toBe('present');
    if (row?.observation?.outcome.kind !== 'present') throw new Error('Pin Task was not materialized');
    const entryRef = row.entryRef;
    const { title, scopeLabel } = row.observation.outcome.snapshot;
    const displayAtMark = { title, scopeLabel };
    expect(TriageSetEntryPinnedResultV1Schema.parse(await invoke(first, TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
      { v: 1, pinned: true, entryRef, displayAtMark }))).toMatchObject({ v: 1, status: 'pinned' });
    const listed = TriageListPinnedEntriesResultV1Schema.parse(await invoke(second, TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
      { v: 1, limit: 20 }));
    expect(listed.pins).toEqual(expect.arrayContaining([expect.objectContaining({ entryRef, displayAtMark })]));
    // Close both readers before mounting another Account executable: the pin
    // must come from Account storage rather than either reader's retained state.
    await clients.pop()!.close();
    await clients.pop()!.close();
    await daemon.stop();
    daemon = await startTestDaemon(daemonParams);
    await daemon.stop();
    const cold = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
    clients.push(cold);
    await waitFor(() => cold.isAccountReady(), { context: 'fresh pin reader Account readiness' });
    const retained = TriageListPinnedEntriesResultV1Schema.parse(await invoke(cold, TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
      { v: 1, limit: 20 }));
    expect(retained.pins).toEqual(expect.arrayContaining([expect.objectContaining({ entryRef, displayAtMark })]));
    expect(TriageSetEntryPinnedResultV1Schema.parse(await invoke(cold, TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
      { v: 1, pinned: false, entryRef }))).toMatchObject({ v: 1, status: 'unpinned' });
    const after = TriageListPinnedEntriesResultV1Schema.parse(await invoke(cold, TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
      { v: 1, limit: 20 }));
    expect(after.pins).not.toEqual(expect.arrayContaining([expect.objectContaining({ entryRef })]));
    // Re-pin must use the existing tombstone revision rather than treating
    // this durable identity as absent forever after its first Unpin.
    expect(TriageSetEntryPinnedResultV1Schema.parse(await invoke(cold, TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
      { v: 1, pinned: true, entryRef, displayAtMark }))).toMatchObject({ v: 1, status: 'pinned' });
    expect(TriageListPinnedEntriesResultV1Schema.parse(await invoke(cold, TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
      { v: 1, limit: 20 })).pins).toEqual(expect.arrayContaining([expect.objectContaining({ entryRef, displayAtMark })]));
  } finally {
    for (const client of clients.reverse()) await client.close();
    await daemon.stop(); await server.stop();
  }
}, 0);

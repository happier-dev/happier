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
import { connectUiPersonActionClient, connectUiTriageActionClient, mountUiInboxJourney } from '@happier-tests/ui-action-client';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ReviewGetResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ReviewCommentCreateResponseV1Schema, ReviewCommentTransitionResponseV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { createReviewFindingIdentityV1, createReviewFindingMessageHashV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { startFinJourneyFixture } from '../../src/testkit/finJourney';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
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

it('publishes daemon Review attention into the person Inbox and resolves the same entry after the final shared decision', async () => {
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  const fixture = await startFinJourneyFixture({ testDir: run.testDir(`review-attention-${randomUUID()}`), dbProvider: 'postgres',
    serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } }).catch(async error => { await postgres.stop(); throw error; });
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let inbox: Awaited<ReturnType<typeof mountUiInboxJourney>> | undefined;
  try {
    const actor = await fixture.createAccount('review-attention-owner');
    // Real stored terminal sign-in, daemon activation and ApiMachine changes
    // ingress own this producer. Do not start a second attention lifecycle here.
    const machine = await fixture.enrollDaemon(actor);
    ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl, accountSecret: actor.auth.accountSigningSeed });
    await waitFor(() => ui!.isMachineActive(machine.target.machineId), { context: 'Review attention daemon is visible to the person' });
    inbox = await mountUiInboxJourney();
    const reviewId = randomUUID();
    const title = `Private Review attention ${randomUUID()}`;
    const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(createCredentialedAccountArtifactStore(actor.credentials)));
    await runWithServerHttpBaseUrl(fixture.server.baseUrl, async () => {
      const round = await records.start({ reviewId, title, subjectKind: 'repository', sourceKind: 'direct', reviewerIds: [], startedAt: Date.now() });
      await records.settle({ ...round, outcome: 'completed', finishedAt: Date.now(), runs: [] });
    });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const }, serverId: ui.serverId };
    const createFinding = async (findingTitle: string) => {
      const path = `${findingTitle}.ts`;
      const fingerprint = { normalizedMessageHash: createReviewFindingMessageHashV1(findingTitle) };
      const response = await ui!.execute('reviews.comments.create', { reviewId, body: findingTitle,
        finding: { id: findingTitle, title: findingTitle, summary: findingTitle, severity: 'high', category: 'correctness' },
        findingIdentity: createReviewFindingIdentityV1({ title: findingTitle, path, fingerprint }), fingerprint,
        anchor: { kind: 'file', filePath: path }, snapshot: { kind: 'none', capturedAt: 1 },
        authorIntent: 'open', clientMutationId: randomUUID() }, context);
      if (!response.ok) throw new Error(`Create Review finding refused (${response.errorCode})`);
      return ReviewCommentCreateResponseV1Schema.parse(response.result).comment;
    };
    const first = await createFinding('First pending decision');
    const second = await createFinding('Second pending decision');
    const notices = () => inbox!.getCurrent()?.openAccountNotices.filter(entry => entry.header.title === title) ?? [];
    await waitFor(() => notices().length === 1, { context: 'Daemon attention reaches the mounted person Inbox through real Account sync' });
    const noticeId = notices()[0]!.artifact.id;
    expect(notices()[0]!.header).toMatchObject({ source: { kind: 'plugin', pluginId: 'happier.triage' },
      type: 'decision', resolved: false, reviewAttention: { requestedVerdict: false, subjectKind: 'repository' } });
    expect(inbox.getCurrent()!.items).toEqual(expect.arrayContaining([expect.objectContaining({ title, view: 'needs_you' })]));
    const outsider = await fixture.createAccount('unshared-review-observer');
    const outside = await outsider.execute('artifact.list', { artifactIds: [reviewId, noticeId] });
    if (!outside.ok) throw new Error(`Unshared Account inventory refused (${outside.errorCode})`);
    expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(outside.result).items).toEqual([]);
    const transition = async (comment: typeof first) => {
      // A second device writes through the ordinary credentialed CLI Action
      // owner. The mounted UI must consume its pushed change, never refresh.
      const result = await actor.execute('reviews.comments.transition', buildReviewTriageTransitionRequestV1({ comment,
        decision: 'reject', clientMutationId: randomUUID() }));
      if (!result.ok) throw new Error(`Review finding decision refused (${result.errorCode})`);
      return ReviewCommentTransitionResponseV1Schema.parse(result.result);
    };
    await transition(first);
    await waitFor(async () => {
      const current = await actor.execute('review.get', { reviewId });
      if (!current.ok) throw new Error(current.errorCode);
      return ReviewGetResponseV1Schema.parse(current.result).review.counts.needsDecision === 1;
    }, { context: 'One decision remains authoritative after the first transition' });
    expect(notices().map(entry => entry.artifact.id)).toEqual([noticeId]);
    await transition(second);
    await waitFor(() => notices().length === 0, { context: 'Final decision resolves the daemon-produced Inbox entry without a manual refresh' });
    const retained = await actor.execute('artifact.get', { artifactId: noticeId });
    expect(retained).toMatchObject({ ok: true, result: { artifact: { header: { title, resolved: true } } } });
    expect(inbox.getCurrent()!.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ title })]));
  } finally {
    await inbox?.unmount();
    await ui?.close();
    try { await fixture.stop(); } finally { await postgres.stop(); }
  }
}, 0);

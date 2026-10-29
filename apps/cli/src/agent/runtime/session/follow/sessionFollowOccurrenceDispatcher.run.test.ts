import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFollowOccurrenceDispatcher } from './sessionFollowOccurrenceDispatcher';
import { createAccountRunFollowRoutes } from './accountRunFollowRoutes';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1, resolveExecutionRunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { resolveWorkflowRunFollowEventV1 } from '@happier-dev/protocol/workflows/composeWorkflowRunWorkerUpdateV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { SessionFollowRunOccurrenceSchema } from '@/daemon/sessions/sessionActivityChangedContract';
import * as daemonTransport from '@/daemon/controlHttp';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { createPersonalFollowOccurrenceDispatcher } from '@/notifications/activity/dispatchPersonalFollowOccurrence';

afterEach(() => vi.restoreAllMocks());

it('reads only selected detached Run outputs on their exact source invalidation', async () => {
  const source = { kind: 'execution_run' as const, machineId: 'machine', runId: 'detached-run' };
  const outputRef = { kind: 'scm_diff_summary', output: 'walkthrough', comparisonId: 'comparison', resultId: 'result' };
  const listRequests: URL[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const request = new URL(String(url));
    expect(request.pathname).toBe('/v2/account/session-follows');
    listRequests.push(request);
    const requested = JSON.parse(request.searchParams.get('source') ?? 'null');
    return { status: 200, data: { follows: requested?.runId === source.runId ? [{ source, following: false,
      persistent: false, policy: { preset: 'custom', events: {} }, once: [{ kind: 'output_ready', outputRef }] }] : [] } };
  });
  const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => true, dispatchPersonal: async () => { throw new Error('Unavailable source has no effect'); } });
  try {
    await dispatcher.dispatchAccountSourceRange({ source });
    expect(listRequests.map(request => JSON.parse(request.searchParams.get('source') ?? 'null'))).toEqual([source]);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([{ v: 1, source, outputRef }]);
    for (let index = 0; index < 100; index++) await dispatcher.dispatchAccountSourceRange({ sourceSessionId: `unrelated-${index}` });
    expect(posts).toHaveBeenCalledTimes(1);
  } finally { dispatcher.dispose(); }
});

it('does not re-read unchanged Run sources when another once intent becomes a receipt', async () => {
  const sources = Array.from({ length: 20 }, (_, index) => ({ kind: 'execution_run' as const, machineId: 'machine', runId: `run-${index}` }));
  let spent = false;
  const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const request = new URL(String(url));
    const selected = JSON.parse(request.searchParams.get('source') ?? 'null');
    return { status: 200, data: { follows: sources.filter(source => !selected || selected.runId === source.runId).map(source => ({
      source, following: false, persistent: false, policy: { preset: 'custom', events: {} },
      once: spent && source === sources[0] ? null : [{ kind: 'run_settled' }],
      ...(spent && source === sources[0] ? { onceDeliveries: [{ original: { source, terminalEventId: 'settled-original' }, event: { kind: 'finished' } }] } : {}),
    })) } };
  });
  const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => true, dispatchPersonal: async () => { throw new Error('Unavailable source has no effect'); } });
  try {
    await dispatcher.dispatchAccountSourceRange();
    expect(posts).toHaveBeenCalledTimes(sources.length);
    posts.mockClear();
    spent = true;
    await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
    for (let index = 0; index < 100; index++) await dispatcher.dispatchAccountSourceRange({ sourceSessionId: `unrelated-${index}` });
    expect(posts).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(2);
    await dispatcher.dispatchAccountSourceRange({ source: sources[1]! });
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([{ v: 1, source: sources[1] }]);
  } finally { dispatcher.dispose(); }
});

it('loads Run interests on reconnect and uses that projection for Session arrivals until Follow configuration changes', async () => {
  const sourceSessionId = 'c111111111111111111111111';
  const selected = ['first-run', 'later-run'].map(runId => ({
    source: { kind: 'execution_run' as const, sessionId: sourceSessionId, runId }, following: true,
    persistent: true, policy: { preset: 'important' as const },
  }));
  const unrelated = Array.from({ length: 1000 }, (_, index) => ({
    source: { kind: 'workflow_run' as const, runId: `unrelated-${index}` }, following: true,
    persistent: true, policy: { preset: 'important' as const },
  }));
  const queries: { source: unknown; cursor: string | null }[] = [];
  let removed = false;
  let available = false;
  let returnedRows = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const request = new URL(String(url));
    expect(request.pathname).toBe('/v2/account/session-follows');
    const source = request.searchParams.get('source');
    const cursor = request.searchParams.get('cursor');
    queries.push({ source: source ? JSON.parse(source) : null, cursor });
    const requested = source ? JSON.parse(source) as { runId: string } : null;
    const follows = requested ? selected.filter(relation => relation.source.runId === requested.runId)
      : cursor === null ? unrelated : removed ? [] : selected;
    returnedRows += follows.length;
    return { status: 200, data: { follows,
      ...(!requested && cursor === null ? { continuation: 'selected-next' } : {}) } };
  });
  const posts = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => available
    ? { status: 200, data: { ok: true, v: 1, original: { source: (body as { source: unknown }).source,
      terminalEventId: 'terminal' }, event: { kind: 'finished' }, personal: { policy: { preset: 'important' }, alreadyRepresented: false }, routes: [] } }
    : { status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
  const effects = vi.fn();
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => true, dispatchPersonal: effects });
  try {
    // A recreated Account lifetime can receive a source before reconnect.
    // Discover once, sharing that read across simultaneous arrivals.
    await Promise.all(Array.from({ length: 100 }, (_, index) => dispatcher.dispatchAccountSourceRange({ sourceSessionId: `unrelated-${index}` })));
    expect(returnedRows).toBe(1002);
    expect(posts).not.toHaveBeenCalled();
    await dispatcher.dispatchAccountSourceRange({ sourceSessionId });
    expect(returnedRows).toBe(1002);
    expect(queries).toEqual([
      { source: null, cursor: null },
      { source: null, cursor: 'selected-next' },
    ]);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual(selected.map(({ source }) => ({ v: 1, source })));
    posts.mockClear();
    for (let index = 0; index < 100; index++) await dispatcher.dispatchAccountSourceRange({ sourceSessionId: `unrelated-${index}` });
    expect(posts).not.toHaveBeenCalled();
    // Ordinary parent-Session arrivals do not prove that any retained Run's
    // unavailable frontier has become available (PERF #37).
    for (let index = 0; index < 100; index++) await dispatcher.dispatchAccountSourceRange({ sourceSessionId });
    expect(queries).toHaveLength(2);
    expect(posts).not.toHaveBeenCalled();
    // The existing exact Run publication is an availability fact. It releases
    // only that source, and a refused attempt holds again immediately.
    await dispatcher.dispatchExecutionRunSourceChange(selected[0]!.source);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([{ v: 1, source: selected[0]!.source }]);
    expect(posts.mock.calls[0]?.[2]?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'exact_run' });
    posts.mockClear();
    for (let index = 0; index < 100; index++) await dispatcher.dispatchAccountSourceRange({ sourceSessionId });
    expect(posts).not.toHaveBeenCalled();
    // A real Machine/daemon reconnect is the other existing recovery owner.
    await dispatcher.dispatchAccountSourceRange();
    // Every active interest has real reconnect demand, including the Workflow
    // rows deliberately placed ahead of these two Runs in the paged census.
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([...unrelated, ...selected].map(({ source }) => ({ v: 1, source })));
    expect(posts.mock.calls.slice(-selected.length).map(([, , options]) => options?.params)).toEqual(selected.map(() => ({
      includeTargetMachineId: 'true', releaseReason: 'full_recovery',
    })));
    posts.mockClear();
    available = true;
    await dispatcher.dispatchExecutionRunSourceChange(selected[0]!.source);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([{ v: 1, source: selected[0]!.source }]);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(effects.mock.calls[0]?.[0]).toMatchObject({ occurrence: { original: { source: selected[0]!.source, terminalEventId: 'terminal' } } });
    posts.mockClear();
    removed = true;
    await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
    expect(queries).toHaveLength(8);
    await dispatcher.dispatchAccountSourceRange({ sourceSessionId });
    expect(queries).toHaveLength(8);
    expect(posts).not.toHaveBeenCalled();
  } finally { dispatcher.dispose(); }
});

it('holds unavailable Account discovery without per-arrival retries and repairs it on the next Follow change', async () => {
  let available = false;
  const source = { kind: 'execution_run' as const, sessionId: 'watched-session', runId: 'watched-run' };
  const reads = vi.spyOn(axios, 'get').mockImplementation(async () => available
    ? { status: 200, data: { follows: [{ source, following: true, persistent: true, policy: { preset: 'important' } }] } }
    : { status: 503, data: {} });
  const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
  const lifetime = new AbortController();
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test',
    machineId: 'machine', installationId: 'installation', signal: lifetime.signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => true, dispatchPersonal: async () => { throw new Error('Unavailable source has no effect'); } });
  try {
    for (let index = 0; index < 100; index++) await dispatcher.dispatchAccountSourceRange({ sourceSessionId: source.sessionId });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(posts).not.toHaveBeenCalled();
    available = true;
    await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([{ v: 1, source }]);
    await dispatcher.dispatchAccountSourceRange({ sourceSessionId: source.sessionId });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(posts).toHaveBeenCalledTimes(1);
    available = false;
    await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
    for (let index = 0; index < 100; index++) await dispatcher.dispatchAccountSourceRange({ sourceSessionId: source.sessionId });
    expect(reads).toHaveBeenCalledTimes(3);
    expect(posts).toHaveBeenCalledTimes(1);
    available = true;
    await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
    expect(reads).toHaveBeenCalledTimes(4);
    // Configuration discovery recovered, but a Follow edit does not prove
    // that the refused Run frontier became available.
    expect(posts).toHaveBeenCalledTimes(1);
    await dispatcher.dispatchExecutionRunSourceChange(source);
    expect(reads).toHaveBeenCalledTimes(5);
    expect(posts).toHaveBeenCalledTimes(2);
    lifetime.abort();
    await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
    expect(reads).toHaveBeenCalledTimes(5);
    expect(posts).toHaveBeenCalledTimes(2);
  } finally { dispatcher.dispose(); }
});

it('does not replace a pushed Follow configuration with an older unfinished discovery', async () => {
  const oldSource = { kind: 'execution_run' as const, sessionId: 'old-session', runId: 'old-run' };
  const newSource = { kind: 'execution_run' as const, sessionId: 'new-session', runId: 'new-run' };
  const page = (source: typeof oldSource) => ({ status: 200, data: { follows: [{ source,
    following: true, persistent: true, policy: { preset: 'important' } }] } });
  let finishOldRead!: (response: ReturnType<typeof page>) => void;
  const oldRead = new Promise<ReturnType<typeof page>>(resolve => { finishOldRead = resolve; });
  const reads = vi.spyOn(axios, 'get').mockImplementationOnce(async () => oldRead).mockImplementation(async () => page(newSource));
  const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => true, dispatchPersonal: async () => { throw new Error('Unavailable source has no effect'); } });
  const initial = dispatcher.dispatchAccountSourceRange({ sourceSessionId: oldSource.sessionId });
  try {
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
    finishOldRead(page(oldSource));
    await initial;
    await dispatcher.dispatchAccountSourceRange({ sourceSessionId: oldSource.sessionId });
    await dispatcher.dispatchAccountSourceRange({ sourceSessionId: newSource.sessionId });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([{ v: 1, source: newSource }]);
    await dispatcher.dispatchExecutionRunSourceChange(newSource);
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([{ v: 1, source: newSource }, { v: 1, source: newSource }]);
  } finally { finishOldRead(page(oldSource)); await initial; dispatcher.dispose(); }
});

it('holds unavailable Discussion demand across dispatcher replacement and unrelated arrivals until exact source availability', async () => {
  const source = { kind: 'discussion' as const, discussionId: 'held-discussion' };
  const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null };
  const lifetime = new AbortController();
  const runRoutes = createAccountRunFollowRoutes({ credentials, serverHttpBaseUrl: 'http://run-follow.test',
    signal: lifetime.signal, isCurrent: async () => true });
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { follows: [{ source, following: true,
    persistent: true, policy: { preset: 'important' }, once: null }] } });
  let available = false;
  const posts = vi.spyOn(axios, 'post').mockImplementation(async () => available
    ? { status: 200, data: { ok: true, v: 1, discussion: { source, messageId: 'fresh-message', seq: 1,
      event: { kind: 'person_wrote' }, personal: { policy: { preset: 'important' }, alreadyRepresented: true } } } }
    : { status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
  const create = () => createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials,
    serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test', machineId: 'machine', installationId: 'installation',
    signal: lifetime.signal, runRoutes, isCurrent: async () => true, subscribeInvalidation: () => () => {},
    resolveSourceKeyContext: async () => null, isPersonalCurrent: () => true,
    dispatchPersonal: async () => { throw new Error('A represented Discussion original has no new effect'); } });
  let dispatcher = create();
  try {
    await dispatcher.dispatchAccountSourceRange();
    expect(posts).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 100; index++) {
      dispatcher.dispose(); dispatcher = create();
      await dispatcher.dispatchAccountSourceRange({ configurationChanged: true });
      await dispatcher.dispatchAccountSourceRange({ sourceSessionId: `unrelated-${index}` });
    }
    expect(posts).toHaveBeenCalledTimes(1);
    available = true;
    await dispatcher.dispatchAccountSourceRange({ workflowRunIds: [], discussionIds: [source.discussionId] });
    expect(posts).toHaveBeenCalledTimes(2);
    expect(posts.mock.calls[1]?.[1]).toEqual({ v: 1, source });
  } finally { dispatcher.dispose(); runRoutes.dispose(); lifetime.abort(); }
});

it('does not re-demand an unavailable source during ten idle minutes or 100 unrelated arrivals, and reads its later occurrence once', async () => {
  vi.useFakeTimers();
  const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { follows: [] } });
  let available = false;
  const posts = vi.spyOn(axios, 'post').mockImplementation(async () => available
    ? { status: 200, data: { ok: true, v: 1, original: { source: { kind: 'workflow_run', runId: 'unavailable-run' }, revision: 2 },
      event: { kind: 'finished' }, routes: [] } }
    : { status: 409, data: { ok: false, v: 1, error: 'source_unavailable' } });
  const effects = vi.fn();
  const lifetime = new AbortController();
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test',
    machineId: 'machine', installationId: 'installation', signal: lifetime.signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => true, dispatchPersonal: effects });
  try {
    await dispatcher.dispatchAccountSourceRange({ workflowRunIds: ['unavailable-run'], discussionIds: ['unavailable-discussion'] });
    expect(posts.mock.calls.map(([, body]) => body)).toEqual([
      { v: 1, source: { kind: 'workflow_run', runId: 'unavailable-run' } },
      { v: 1, source: { kind: 'discussion', discussionId: 'unavailable-discussion' } },
    ]);
    expect(reads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(posts).toHaveBeenCalledTimes(2);
    expect(reads).not.toHaveBeenCalled();
    for (let index = 0; index < 100; index++) {
      await dispatcher.dispatchAccountSourceRange({ sourceSessionId: `c${String(index).padStart(24, '0')}` });
    }
    expect(posts).toHaveBeenCalledTimes(2);
    available = true;
    await dispatcher.dispatchAccountSourceRange({ workflowRunIds: ['unavailable-run'] });
    expect(posts).toHaveBeenCalledTimes(3);
    expect(posts.mock.calls[2]?.[1]).toEqual({ v: 1, source: { kind: 'workflow_run', runId: 'unavailable-run' } });
    lifetime.abort();
    await dispatcher.dispatchAccountSourceRange({ workflowRunIds: ['cancelled-run'] });
    expect(posts).toHaveBeenCalledTimes(3);
    expect(effects).not.toHaveBeenCalled();
  } finally { dispatcher.dispose(); vi.useRealTimers(); }
});

it('rechecks only changed Account Run sources without listing unrelated follows, retaining the final personal proof', async () => {
  const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { follows: [] } });
  let followed = true;
  const sources: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    expect(new URL(String(url)).pathname).toBe('/v2/follows/sources/run-occurrence-routes');
    sources.push(body);
    const personal = followed ? { policy: { preset: 'quiet' }, alreadyRepresented: false } : undefined;
    followed = false;
    return { status: 200, data: { ok: true, v: 1,
      original: { source: { kind: 'workflow_run', runId: 'changed-run' }, revision: 4 }, event: { kind: 'finished' },
      routes: [], ...(personal ? { personal } : {}) } };
  });
  const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null };
  const serverHttpBaseUrl = 'http://run-follow.test';
  const settings = accountSettingsParse({});
  const snapshot = { source: 'network' as const, settings, rawSettings: {}, ...notificationCatalogFixture(settings),
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials)) };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl,
    isCurrent: async () => true });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials, serverId: 'home', serverHttpBaseUrl,
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => operationContext.isCurrent(), dispatchPersonal: (dispatch, isCurrent) =>
      createPersonalFollowOccurrenceDispatcher({ operationContext, isCurrent: () => isCurrent() })(dispatch) });
  try {
    await expect(dispatcher.dispatchAccountSourceRange({ workflowRunIds: ['changed-run'] })).rejects.toThrow('personal_follow_scope_retired');
    expect(sources).toEqual([
      { v: 1, source: { kind: 'workflow_run', runId: 'changed-run' } },
      { v: 1, original: { source: { kind: 'workflow_run', runId: 'changed-run' }, revision: 4 } },
    ]);
    expect(reads).not.toHaveBeenCalled();
  } finally { dispatcher.dispose(); }
});

it.each([
  ['execution_run', 'notification', 'finished'], ['workflow_run', 'notification', 'finished'],
  ['execution_run', 'catchup', 'finished'], ['workflow_run', 'catchup', 'finished'],
  ['workflow_run', 'notification', 'needs_you'], ['workflow_run', 'notification', 'update_posted'],
  ['workflow_run', 'catchup', 'needs_you'], ['workflow_run', 'catchup', 'update_posted'],
  ['execution_run', 'notification', 'needs_you'], ['execution_run', 'catchup', 'needs_you'],
] as const)('settles a muted %s original through Pending on %s for %s and delivers only a fresh original after Undo', async (kind, entry, eventKind) => {
  const destinationSessionId = 'c222222222222222222222222';
  const permissionOccurrence = kind === 'execution_run' && eventKind === 'needs_you'
    ? resolveExecutionRunFollowOccurrenceV1({ sessionId: 'c111111111111111111111111', runId: 'run-one',
      status: 'running', terminalEventId: null, attention: { kind: 'permission_required', requestIds: ['permission-one'],
        requests: [{ requestId: 'permission-one', createdAt: 1 }] } }) : null;
  if (kind === 'execution_run' && eventKind === 'needs_you') expect(permissionOccurrence?.event).toEqual({ kind: 'needs_you', type: 'approval' });
  let original: RunFollowOriginalV1 = kind === 'execution_run'
    ? permissionOccurrence?.original ?? { source: { kind, sessionId: 'c111111111111111111111111', runId: 'run-one' }, terminalEventId: 'terminal-one' }
    : { source: { kind, runId: 'workflow-one' }, revision: 4 };
  if ('output' in original) throw new Error('This Session-input fixture requires a terminal, permission or Workflow original');
  const source = original.source;
  const boundary = createWorkflowRunStorageTestkit({ runId: 'workflow-one', machineId: 'source-machine',
    origin: { kind: 'direct' }, state: eventKind === 'finished' ? 'succeeded' : 'running' });
  let workflow = WorkflowRunSummaryV1Schema.parse({ ...boundary.run(), revision: 4,
    attentionRequired: eventKind === 'needs_you', invocationAttentionRequired: eventKind === 'needs_you' });
  const event = kind === 'execution_run' ? permissionOccurrence?.event ?? { kind: 'finished' as const } : resolveWorkflowRunFollowEventV1(workflow)!;
  const policy = { preset: permissionOccurrence ? 'important' as const : 'quiet' as const };
  let occurrence = SessionFollowRunOccurrenceSchema.parse({ original, event });
  const sourceRow = { ...createSessionNotificationContextFixture(destinationSessionId), ownerAccountId: 'account-1',
    encryptionMode: 'plain', dataEncryptionKey: null, archivedAt: null, active: true,
    metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'receiver-machine' }) };
  const pending = new Map<string, { body: unknown; suppressed: boolean }>();
  let muted = true;
  let routePresent = true;
  let returnDifferentOriginal = false;
  let sourceCurrent = true;
  const replacementOriginal: RunFollowOriginalV1 = 'terminalEventId' in original
    ? { ...original, terminalEventId: 'replacement-terminal' }
    : 'permissionRequests' in original ? { ...original, permissionRequests: [{ requestId: 'permission-one', createdAt: 2 }] }
    : { ...original, revision: original.revision + 1 };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [{ source, destinationSessionId,
      relation: 'follower', policy, deliveryState: 'eligible', sourceAvailability: 'available', hasPendingUpdates: true }] } };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: muted ? [{ kind: 'source', source }] : [] } };
    if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: sourceRow } };
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v3/automations/runs/workflow-storage') return { status: 200, data: workflow };
    if (path.endsWith('/run-occurrence-routes') && kind === 'execution_run' && entry === 'notification') {
      expect(options?.params).toEqual({ includeTargetMachineId: 'true', releaseReason: 'exact_run' });
    }
    if (path.endsWith('/run-occurrence-routes') && !sourceCurrent) return { status: 200, data: { ok: false, v: 1, error: 'source_unavailable' } };
    if (path.endsWith('/run-occurrence-routes')) return { status: 200, data: { ok: true, v: 1,
      original: returnDifferentOriginal ? replacementOriginal : original, event: occurrence.event,
      routes: routePresent ? [{ destinationSessionId, relation: 'follower', attachedAt: 1, policy,
        ...(kind === 'execution_run' ? { expectedTerminalEventId: null } : { expectedRevision: 3 }) }] : [] } };
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: [] } };
    if (path.endsWith('/pending')) {
      if (typeof body !== 'object' || body === null || !('localId' in body) || typeof body.localId !== 'string') throw new Error('Missing Pending identity');
      const suppressed = pending.get(body.localId)?.suppressed ?? muted;
      pending.set(body.localId, { body, suppressed });
      if (suppressed) return { status: 400, data: { error: 'session_input_muted' } };
      return { status: 200, data: { didWrite: true, message: { localId: body.localId, seq: 1 } } };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
    serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test', machineId: 'receiver-machine', installationId: 'installation',
    signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
    resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    const hints: Promise<unknown>[] = [];
    vi.spyOn(daemonTransport, 'daemonPost').mockImplementation(async (_path, body) => {
      if (!body || typeof body !== 'object' || !('followOccurrence' in body)) throw new Error('Missing original hint');
      hints.push(dispatcher.dispatch(SessionFollowRunOccurrenceSchema.parse(body.followOccurrence)));
      return { ok: true };
    });
    const client = createWorkflowRunStorageClient({ token: 'token', machineId: 'source-machine',
      serverHttpBaseUrl: 'http://run-follow.test', createPublisherHeader: async () => 'signed-publisher' });
    const deliver = async () => {
      if (entry === 'catchup') return dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [] });
      if (kind === 'execution_run') return dispatcher.dispatch(occurrence);
      await client.execute({ operation: 'transition', runId: workflow.id });
      await Promise.all(hints.splice(0));
    };
    await deliver();
    const oldLocalId = deriveSessionFollowInputLocalIdV1({ destinationSessionId, original });
    expect(pending.size).toBe(1);
    expect(pending.get(oldLocalId)?.suppressed).toBe(true);
    muted = false;
    if (permissionOccurrence) {
      sourceCurrent = false;
      await deliver();
      expect(pending.size).toBe(1);
      sourceCurrent = true;
    }
    if (entry === 'notification') {
      returnDifferentOriginal = true;
      await deliver();
      expect(pending.size).toBe(1);
      returnDifferentOriginal = false;
    }
    await deliver();
    expect(pending.size).toBe(1);
    expect(pending.get(oldLocalId)?.suppressed).toBe(true);
    original = replacementOriginal;
    occurrence = SessionFollowRunOccurrenceSchema.parse({ original, event });
    if ('revision' in original) workflow = WorkflowRunSummaryV1Schema.parse({ ...workflow, revision: original.revision });
    await deliver();
    expect(pending.size).toBe(2);
    const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId, original });
    expect(pending.get(localId)?.suppressed).toBe(false);
    expect(JSON.stringify(pending.get(localId)?.body)).toContain(JSON.stringify(SessionFollowInputV1Schema.parse({ v: 1, original,
      event: occurrence.event, delivery: permissionOccurrence ? 'wake' : 'next_turn' })));
    await deliver();
    expect(pending.size).toBe(2);
    routePresent = false;
    await deliver();
    expect(pending.size).toBe(2);
  } finally { dispatcher.dispose(); }
});

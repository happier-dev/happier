import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture, createRootLayoutFeaturesResponse, createSessionFixture,
    createSessionListRenderableSessionFixture, flushHookEffects, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The anchored panel's portal and window measurement are the platform boundary; the panel's own parts stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } =
    await import('@/sync/domains/machines/reachability/machineReachability');
const { SessionFollowSourcesEditor } = await import('./SessionFollowSourcesEditor');
const before = storage.getState();
beforeEach(() => network.resetRequests());

afterEach(() => { setServerReachabilityNetworkAllowed(true); standardCleanup(); storage.setState(before, true);
    clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

async function mountRetryEditor(requestFailed = false, initialPolicy: FollowPolicyV1 = { preset: 'important' },
    onSourceRead?: (signal?: AbortSignal | null) => Promise<Response>) {
    const home = await network.addHome('https://follow-retry.test', 'follow-account');
    setActiveServerId(home.id);
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    const destination = createSessionFixture({ id: 'destination', serverId: home.id });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, following: { enabled: true } } } });
    let policy = initialPolicy;
    let refusePolicyWrite = false;
    const policyWrites: unknown[] = [];
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (path === '/v2/account/session-follow-rules') return Response.json({ rules: [] });
        if (path === '/v2/sessions/destination') return Response.json(createPlainSessionByIdResponseFixture(destination));
        if (path === '/v2/sessions/destination/follows/sessions/source' && init?.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            policyWrites.push(body);
            if (refusePolicyWrite) return Response.json({ error: 'session_archived' }, { status: 409 });
            policy = body.policy;
            return Response.json({ changed: true, source: { sourceSessionId: 'source', destinationSessionId: 'destination',
                policy, deliveryState: 'eligible', hasPendingUpdates: false } });
        }
        if (path === '/v2/sessions/destination/follows/sessions') return Response.json({ sources: [{
            sourceSessionId: 'source', destinationSessionId: 'destination', policy,
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] });
        // An unavailable source key is retryable, not transferable. The real crypto reader
        // classifies the server's unavailable detail; no crypto or preparation owner is mocked.
        if (path === '/v2/sessions/source') return onSourceRead
            ? await onSourceRead(init?.signal) : Response.json({ error: 'not_found' }, { status: 404 });
        return null;
    });
    const machine = createMachineFixture({ id: 'runner', kind: 'ephemeral_session_runner', activeAt: Date.now(),
        operationProtocolCapabilities: { sessionFollow: { contextV1: true } } });
    const source = createSessionListRenderableSessionFixture({ id: 'source', encryptionMode: 'e2ee' });
    storage.setState(state => ({ profileScope: { serverId: home.id, accountId: home.accountId },
        profile: { ...state.profile, id: home.accountId }, machines: { [machine.id]: machine },
        machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
        sessionListRowsByServerId: { [home.id]: { [source.id]: source } } }));
    const scope = { serverId: home.id, accountId: home.accountId };
    if (requestFailed) recordMachineRequestFailed({ ...scope, machineId: machine.id });
    const screen = await renderScreen(<SessionFollowSourcesEditor destination={destination}
        serverId={home.id} destinationMachineId={machine.id} />);
    const sourceRequests = () => network.httpRequests.filter(request => new URL(request.url).pathname === '/v2/sessions/source').length;
    return { screen, scope, sourceRequests, policyWrites, refusePolicyWrites: (value: boolean) => { refusePolicyWrite = value; } };
}

it('cancels pending source-key preparation when its editor unmounts', async () => {
    let signal: AbortSignal | null | undefined;
    const { screen } = await mountRetryEditor(false, { preset: 'important' }, async value => {
        signal = value;
        return await new Promise<Response>((_resolve, reject) => value?.addEventListener('abort',
            () => reject(new Error('aborted')), { once: true }));
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await screen.unmount();
    expect(signal?.aborted).toBe(true);
});

it('writes an explicit policy through the real Follow Action and retries the failed draft without replacing committed policy', async () => {
    const custom: FollowPolicyV1 = { preset: 'custom', events: { person_wrote: { delivery: 'interrupt' }, finished: { delivery: 'quiet' } } };
    const { screen, policyWrites, refusePolicyWrites } = await mountRetryEditor(false, custom);
    const rowId = 'session-follow-source-source';
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId(rowId), JSON.stringify({
        content: screen.getTextContent(), paths: network.httpRequests.map(request => new URL(request.url).pathname),
    })).toBeTruthy(); });
    await screen.pressByTestIdAsync(rowId);
    const quietSegment = () => screen.findAllByTestId(`${rowId}-policy.preset.quiet`).find((node) => typeof node.props.onPress === 'function');
    refusePolicyWrites(true);
    await act(async () => { quietSegment()?.props.onPress(); });
    await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).toBeTruthy());
    expect(policyWrites).toEqual([{ policy: { preset: 'quiet', voice: false } }]);
    expect(quietSegment()?.props.checked).toBe(true);
    refusePolicyWrites(false);
    await screen.pressByTestIdAsync('session-follow-sources-error');
    await vi.waitFor(() => expect(policyWrites).toHaveLength(2));
    expect(policyWrites[1]).toEqual(policyWrites[0]);
    await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).toBeNull());
    await screen.unmount();
});

it('reads its saved rule filter and Include again result back into the open editor', async () => {
    const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
    const { SetSessionFollowRuleRequestV1Schema } = await import('@happier-dev/protocol/sessions/follow/sessionFollowRuleV1');
    const home = await network.addHome('https://follow-rule-refresh.test', 'follow-account');
    setActiveServerId(home.id);
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    storage.setState(state => ({ profileScope: { serverId: home.id, accountId: home.accountId },
        profile: { ...state.profile, id: home.accountId } }));
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, following: { enabled: true } } } });
    const receiver = { kind: 'session' as const, sessionId: 'destination' };
    const destination = createSessionFixture({ id: receiver.sessionId, serverId: home.id });
    let rule: import('@happier-dev/protocol/sessions/follow/sessionFollowRuleV1').SessionFollowRuleV1 = { ruleId: 'payments', receiver, version: 3, content: { t: 'plain',
        v: { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [home.id],
            projects: { include: [], exclude: [{ serverId: home.id, projectKey: 'payments' }] } }),
        policy: { preset: 'important' as const } } } };
    let removed = false;
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (path === '/v2/account/session-follow-rules/payments' && init?.method === 'PUT') {
            const body = SetSessionFollowRuleRequestV1Schema.parse(JSON.parse(String(init.body)));
            if (body.expectedVersion !== rule.version) return Response.json({ error: 'version_conflict' }, { status: 409 });
            if (body.content.t !== 'plain') throw new Error('Expected keyless plain rule fixture');
            rule = { ...rule, version: rule.version + 1, content: body.content };
            return Response.json({ rule });
        }
        if (path === '/v2/account/session-follow-rules/payments' && init?.method === 'DELETE') {
            const body: unknown = JSON.parse(String(init.body));
            expect(body).toEqual({ receiver, expectedVersion: rule.version });
            removed = true;
            return Response.json({ changed: true, version: rule.version + 1 });
        }
        if (path === '/v2/account/session-follow-rules') return Response.json({ rules: removed ? [] : [rule] });
        if (path === '/v2/sessions/destination') return Response.json(createPlainSessionByIdResponseFixture(destination));
        if (path === '/v2/sessions/destination/follows/sessions') return Response.json({ sources: [] });
        return null;
    });
    const errors = vi.spyOn(console, 'error');
    const row = 'session-follow-source-rule:payments';
    const screen = await renderScreen(<SessionFollowSourcesEditor destination={destination}
        serverId={home.id} destinationMachineId={null} />);
    try {
        await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId(row)).toBeTruthy(); });
        await screen.pressByTestIdAsync(row);
        await screen.pressByTestIdAsync(`${row}-filter`);
        await screen.pressByTestIdAsync('collection-filter-field:statuses');
        await screen.pressByTestIdAsync('collection-filter-value:statuses:failed');
        await screen.pressByTestIdAsync('collection-filter-done');
        await vi.waitFor(() => expect(rule.version).toBe(4));
        await vi.waitFor(() => expect(screen.findAllByTestId(`${row}-filter`).find(node => typeof node.props.onPress === 'function')?.props.disabled).toBe(false));
        expect(rule.content.t === 'plain' ? rule.content.v.filter.statuses : null).toContain('failed');
        // Include again must use the version the post-Save read returned; a stale
        // projection conflicts at the real writer instead of silently passing.
        await screen.pressByTestIdAsync(`${row}-left-out-payments-include`);
        await vi.waitFor(() => expect(rule.version).toBe(5));
        await vi.waitFor(() => expect(screen.findByTestId(`${row}-left-out-payments`)).toBeNull());
        expect(screen.findByTestId(`${row}-left-out-undo`)).toBeTruthy();
        await vi.waitFor(() => expect(screen.findAllByTestId(`${row}-remove`).find(node => typeof node.props.onPress === 'function')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync(`${row}-remove`);
        await vi.waitFor(() => expect(removed).toBe(true));
        await vi.waitFor(() => expect(screen.findByTestId(row)).toBeNull());
        expect(errors.mock.calls.filter(args => args.some(value => String(value).includes('getSnapshot')))).toEqual([]);
    } finally { await screen.unmount(); errors.mockRestore(); }
});

it('acquires one private census for Following rule counts and draft edits, and refreshes real rule changes', async () => {
    const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
    const { SessionFollowRuleV1Schema } = await import('@happier-dev/protocol/sessions/follow/sessionFollowRuleV1');
    const { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1 } = await import('@happier-dev/protocol/sessions/follow/accountFollow');
    const { SessionListQueryV1Schema, SESSION_LIST_PAGE_MAX_LIMIT } = await import('@happier-dev/protocol/sessions/listing/query');
    const { createSessionListSourceFixture } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const { encodeV2SessionListCursorV1} = await import('@happier-dev/protocol/sessions/control/contract');
    const { createSessionOwnerViewerFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const home = await network.addHome('https://following-rule-demand.test', 'follow-account');
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, following: { enabled: true } } } });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [home.id], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'] });
    let rules = ['payments', 'daily'].map(ruleId => SessionFollowRuleV1Schema.parse({ ruleId,
        receiver: { kind: 'session', sessionId: 'destination' }, version: 1,
        content: { t: 'plain', v: { v: 1, enabled: true, filter, policy: { preset: 'important' } } } }));
    const sessions = Array.from({ length: 1_001 }, (_, index) => {
        const session = createSessionFixture({ id: `member-${index}`, serverId: home.id,
            metadata: { path: '/payments', host: 'test', projectId: 'payments' } });
        return { ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session) };
    });
    const offsets = new Map<string, number>();
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v1/account/profile') return Response.json({ id: home.accountId });
        if (path === '/v2/account/session-follow-preferences') return Response.json(DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1);
        if (path === '/v2/account/session-follow-rules') return Response.json({ rules });
        if (path === '/v2/sessions/destination/follows/sessions') return Response.json({ sources: [] });
        if (path === '/v2/sessions/query') {
            const query = SessionListQueryV1Schema.parse(JSON.parse(String(init?.body)));
            const offset = query.cursor ? offsets.get(query.cursor)! : 0;
            const end = Math.min(offset + (query.limit ?? SESSION_LIST_PAGE_MAX_LIMIT), sessions.length);
            const nextCursor = end < sessions.length ? encodeV2SessionListCursorV1(String(end)) : null;
            if (nextCursor) offsets.set(nextCursor, end);
            return Response.json(createSessionListSourceFixture({ sessions: sessions.slice(offset, end),
                hasNext: nextCursor !== null, nextCursor, attentionHasNext: false, attentionNextCursor: null }));
        }
        return null;
    });
    // Query previews need the actual Sync transport and hydration owner, not
    // only a seeded Account projection sufficient for Following's exact reads.
    const connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: home.accountId,
        credentials: { token: home.token }, request: network.request });
    onTestFinished(connection.dispose);
    await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
    const censusReads = () => network.httpRequests.filter(request => new URL(request.url).pathname === '/v2/account/session-follow-rules').length;
    const sourceReads = () => network.httpRequests.filter(request => new URL(request.url).pathname === '/v2/sessions/destination/follows/sessions').length;
    const row = (ruleId: string) => `session-follow-source-rule:${ruleId}`;
    const commits = new Set<() => void>();
    const screen = await renderScreen(<React.Profiler id="following-counts" onRender={() => {
        for (const notify of commits) notify();
    }}><SessionFollowSourcesEditor destination={{ id: 'destination' }}
        serverId={home.id} destinationMachineId={null} /></React.Profiler>);
    const count = (ruleId: string) => screen.findAllByTestId(row(ruleId))
        .find(node => typeof node.props.subtitle === 'string')?.props.subtitle;
    const waitForCount = (ruleId: string, expected: number) => waitForTestEvent(notify => {
        commits.add(notify);
        return () => { commits.delete(notify); };
    }, () => { expect(count(ruleId)).toContain(`count=${expected}`); });
    try {
        await waitForCount('payments', 1001);
        await waitForCount('daily', 1001);
        expect(censusReads()).toBe(1);
        const sourcesBeforeDetail = sourceReads();
        await act(async () => publishHomeAccountChange(home.id, ['destination'], { changeKinds: ['session'], sessionListQueryAffects: false }));
        await vi.waitFor(() => expect(sourceReads()).toBe(sourcesBeforeDetail + 1));
        await flushHookEffects();
        expect(censusReads()).toBe(1);
        await screen.pressByTestIdAsync(row('payments'));
        await screen.pressByTestIdAsync(`${row('payments')}-filter`);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('count=1001'));
        await screen.pressByTestIdAsync('collection-filter-field:statuses');
        await screen.pressByTestIdAsync('collection-filter-value:statuses:failed');
        // Its value field folds the values it opened.
        await screen.pressByTestIdAsync('collection-filter-condition:statuses:is:value');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('count=0'));
        expect(censusReads()).toBe(1);
        await screen.pressByTestIdAsync(`${row('payments')}-filter-back`);
        rules = rules.map(rule => rule.ruleId === 'daily' ? { ...rule, version: 2,
            content: { t: 'plain' as const, v: { v: 1 as const, enabled: true,
                filter: normalizeSessionListFilterV1({ ...filter, statuses: ['failed'] }), policy: { preset: 'important' as const } } } } : rule);
        await act(async () => publishHomeAccountChange(home.id, ['session-follows'], { changeKinds: ['account'] }));
        await waitForCount('daily', 0);
        expect(count('payments')).toContain('count=1001');
        expect(censusReads()).toBe(2);
        rules = rules.map(rule => rule.ruleId === 'payments' ? { ...rule, version: 3,
            content: { t: 'plain' as const, v: { v: 1 as const, enabled: true,
                filter: normalizeSessionListFilterV1({ ...filter, statuses: ['failed'] }), policy: { preset: 'important' as const } } } } : rule);
        await act(async () => publishHomeAccountChange(home.id, ['unrelated-future-entity'], { changeKinds: ['future_follow_projection'] }));
        await waitForCount('payments', 0);
        expect(censusReads()).toBe(3);
        rules = rules.map(rule => rule.ruleId === 'payments' ? { ...rule, version: 4,
            content: { t: 'plain' as const, v: { v: 1 as const, enabled: true, filter, policy: { preset: 'important' as const } } } } : rule);
        await act(async () => publishHomeAccountChange(home.id, ['unqualified-entity']));
        await waitForCount('payments', 1001);
        expect(censusReads()).toBe(4);
    } finally { commits.clear(); await screen.unmount(); }
});

it('keeps an explicit source-key Retry enabled and dispatches while automatic network work is paused', async () => {
    const { screen, sourceRequests } = await mountRetryEditor();
    const retryId = 'session-follow-source-source-retry';
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId(retryId)).toBeTruthy(); });
    await vi.waitFor(() => expect(sourceRequests()).toBeGreaterThan(0));
    await vi.waitFor(() => expect(screen.findAllByTestId(retryId)[0]?.props.disabled).toBe(false));
    const beforeRetry = sourceRequests();
    await act(async () => { setServerReachabilityNetworkAllowed(false); });
    expect(Boolean(screen.findAllByTestId(retryId)[0]?.props.disabled)).toBe(false);
    await screen.pressByTestIdAsync(retryId);
    await vi.waitFor(() => expect(sourceRequests(), JSON.stringify({
        endpointStatus: storage.getState().endpointStatus,
        requests: network.requests.map(({ method, targetId }) => ({ method, targetId })),
        httpPaths: network.httpRequests.map(request => new URL(request.url).pathname),
        subtitle: screen.findByTestId('session-follow-source-source')?.props.subtitle,
    })).toBeGreaterThan(beforeRetry));
    await screen.unmount();
});

it('resumes automatic source preparation only when the exact Account request failure heals', async () => {
    const { screen, scope, sourceRequests } = await mountRetryEditor(true);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('session-follow-source-source')).toBeTruthy(); });
    expect(sourceRequests(), JSON.stringify(network.requests.map(({ method, targetId }) => ({ method, targetId })))).toBe(0);
    await act(async () => { recordMachineRequestSucceeded({ ...scope, accountId: 'another-account', machineId: 'runner' }); });
    await flushHookEffects();
    expect(sourceRequests()).toBe(0);
    await act(async () => { recordMachineRequestSucceeded({ ...scope, machineId: 'runner' }); });
    await vi.waitFor(() => expect(sourceRequests()).toBeGreaterThan(0));
    await screen.unmount();
});

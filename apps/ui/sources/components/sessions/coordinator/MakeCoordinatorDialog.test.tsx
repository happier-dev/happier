import * as React from 'react';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { SetSessionFollowRuleRequestV1Schema, type SetSessionFollowRuleRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { CustomModalInjectedProps } from '@/modal/types';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key, params) => ['sessionCoordinator.make.overlap', 'sessionCoordinator.make.leftNotice'].includes(key) ? `${key}: ${params?.name}` : key }));
// The Action transport is the boundary: only the coordinator write is answered here; the dialog, the coordinator
// Action wrapper, the notice owner and every other Action (roles.list, follow preview) stay real.
const enableAction = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute: ((...args: Parameters<typeof original.createFrontDoorActionExecute>) => {
        const execute = original.createFrontDoorActionExecute(...args);
        return ((actionId: string, ...rest: unknown[]) => actionId === 'session.coordinator.enable'
            ? enableAction(actionId, ...rest)
            : (execute as (...a: unknown[]) => unknown)(actionId, ...rest)) as typeof execute;
    }) as typeof original.createFrontDoorActionExecute };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { MakeCoordinatorDialog } = await import('./MakeCoordinatorDialog');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const previous = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;

beforeEach(async () => {
    await homes.reset();
    const serverUrl = 'https://coordinator-rules-demand.test';
    serverId = await homes.addHome({ name: 'Coordinator', serverUrl, accountId: 'alice', currentAccount: true });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: true, direct: false, team: false, group: false } });
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { body: { status: 'listed', rows: [{
        key: 'role-overrides', revision: 1,
        content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } },
    }] } });
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    const session = createSessionFixture({ id: 'coordinator', serverId, projectKey: 'payments',
        metadata: { path: '/work/payments', host: 'test', projectId: 'payments' } });
    getStorage().setState(state => ({ sessions: { coordinator: session }, settings: { ...state.settings,
        coordinationCoordinatorSuggestProjectRule: true, coordinationCoordinatorSuggestHomeRule: true } }));
    homes.answer(serverId, '/v2/sessions/coordinator', { body: createPlainSessionByIdResponseFixture(session) });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [{ ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session) }],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
});
afterEach(async () => {
    setScreenSharingPrivacyActive(false);
    standardCleanup();
    retirePresentationNotice();
    enableAction.mockReset();
    await connection?.dispose(); connection = undefined;
    getStorage().setState(previous, true);
});

it('keeps unknown Machine reachability distinct from observed online and offline presence', async () => {
    const session = { ...getStorage().getState().sessions.coordinator!,
        metadata: { path: '/work/payments', host: 'test', machineId: 'coordinator-machine' } };
    getStorage().setState({ sessions: { coordinator: session } });
    const machine = createMachineFixture({ id: 'coordinator-machine', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
    getStorage().getState().applyMachines([machine], true, { sourceServerId: serverId });
    const screen = await renderScreen(<MakeCoordinatorDialog serverId={serverId} sessionId="coordinator" onClose={() => {}} />);
    const note = () => screen.findAll(node => node.props.testID === 'make-coordinator-machine' && node.props.title !== undefined)[0];
    await waitForHomeGovernance(() => expect(note()?.props).toMatchObject({
        title: 'sessionCoordinator.make.machineOnline', subtitle: 'sessionCoordinator.make.machineOnlineDescription',
    }));
    await act(async () => getStorage().getState().applyMachines([{ ...machine, active: false }], true, { sourceServerId: serverId }));
    expect(note()?.props).toMatchObject({
        title: 'sessionCoordinator.make.machineOffline', subtitle: 'sessionCoordinator.make.machineOfflineDescription',
    });
    // The recorded Session hostname remains readable when its Machine is not visible.
    await act(async () => getStorage().getState().applyMachines([], true, { sourceServerId: serverId }));
    expect(note()?.props).toMatchObject({ title: 'test', subtitle: 'common.unavailable' });
});

it('reads the private rule census once per Make coordinator open for suggestions, Managed by and overlap', async () => {
    const ruleReads = () => homes.requests.filter(request => request.path === '/v2/account/session-follow-rules').length;
    for (let open = 0; open < 2; open++) {
        const baseline = ruleReads();
        const closed = vi.fn();
        function Host() {
            const [visible, setVisible] = React.useState(true);
            const [chrome, setChrome] = React.useState<Parameters<NonNullable<CustomModalInjectedProps['setChrome']>>[0]>(null);
            const close = React.useCallback(() => { closed(); setVisible(false); }, []);
            return <>{visible ? <MakeCoordinatorDialog serverId={serverId} sessionId="coordinator" onClose={close} setChrome={setChrome} /> : null}
                {visible && chrome?.kind === 'card' ? chrome.footer : null}</>;
        }
        const screen = await renderScreen(<Host />);
        await waitForHomeGovernance(() => {
            for (const scope of ['project', 'home']) {
                const row = screen.findAll(node => node.props.testID === `make-coordinator-rule-${scope}` && node.props.subtitle !== undefined)[0];
                expect(row).toBeDefined();
                expect(['sessionCoordinator.make.count', 'sessionCoordinator.make.countAtLeast']).toContain(row?.props.subtitle);
            }
        });
        expect(ruleReads() - baseline).toBe(1);
        await act(async () => {
            for (let index = 0; index < 1_000; index++) publishHomeAccountChange(serverId, [`unrelated-${index}`], { changeKinds: ['artifact'] });
        });
        expect(ruleReads() - baseline).toBe(1);
        await act(async () => screen.pressByTestId('make-coordinator-cancel'));
        expect(closed).toHaveBeenCalledOnce();
        await screen.unmount();
        expect(ruleReads() - baseline).toBe(1);
    }
});

it('withdraws private Project rules in the role-revocation commit while preserving cold hydration and published keys', async () => {
    const scope = getStorage().getState().profileScope;
    if (!scope) throw new Error('Expected the restored Account scope');
    const session = createSessionFixture({ id: 'coordinator', serverId, ownerAccountId: undefined,
        metadata: { path: '/work/payments', machineId: 'machine', host: 'test' },
        access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }) });
    const rows = { scope, status: 'ready' as const, coverage: 'complete' as const,
        workspaceRefs: [{ id: 'checkout', serverId: scope.serverId, projectKey: 'payments', machineId: 'machine',
            rootPath: '/work/payments', label: null, createdAtMs: 1, lastOpenedAtMs: null }],
        relationships: [], organizations: [], revisionsByPhysicalKey: {} };
    homes.answer(serverId, '/v2/sessions/coordinator', { body: createPlainSessionByIdResponseFixture(session) });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [{ ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session) }],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        body: createPlainProjectAccountRowListFixture({ workspaceRefs: rows.workspaceRefs }),
    });
    const { sync } = await import('@/sync/sync');
    await sync.refreshProjectAccountRows();
    await act(async () => getStorage().setState({ sessions: { coordinator: session }, projectAccountRows: rows }));
    let readProjectRuleCount = () => 0;
    const authorityCommitProjectRuleCounts: number[] = [];
    function Host() {
        const access = getStorage()(state => state.sessions.coordinator?.access);
        React.useLayoutEffect(() => {
            authorityCommitProjectRuleCounts.push(readProjectRuleCount());
        }, [access]);
        return <MakeCoordinatorDialog serverId={serverId} sessionId="coordinator" onClose={() => {}} />;
    }
    const screen = await renderScreen(<Host />);
    const projectRule = () => screen.findByTestId('make-coordinator-rule-project');
    readProjectRuleCount = () => Number(projectRule() !== null);
    expect(projectRule()).not.toBeNull();
    await act(async () => getStorage().setState({ projectAccountRows: { ...rows, status: 'loading', workspaceRefs: [] } }));
    expect(projectRule()).not.toBeNull();
    await act(async () => getStorage().setState({ projectAccountRows: rows }));
    await act(async () => getStorage().setState({ projectAccountRows: null }));
    expect(projectRule()).toBeNull();
    await act(async () => getStorage().setState({ projectAccountRows: rows }));
    expect(projectRule()).not.toBeNull();
    authorityCommitProjectRuleCounts.length = 0;
    await act(async () => getStorage().setState({ sessions: { coordinator: { ...session,
        access: normalizeSessionAccessProjection({ share: { accessLevel: 'view', canApprovePermissions: false } }, { allowLegacy: true }) } } }));
    expect(authorityCommitProjectRuleCounts.length).toBeGreaterThan(0);
    expect(authorityCommitProjectRuleCounts).not.toContain(1);
    expect(projectRule()).toBeNull();
    await act(async () => getStorage().setState({ sessions: { coordinator: { ...session, projectKey: 'payments',
        access: normalizeSessionAccessProjection({ share: { accessLevel: 'view', canApprovePermissions: false } }, { allowLegacy: true }) } } }));
    expect(projectRule()).not.toBeNull();
});

it.each([
    { name: 'a rule is on', suggest: true, message: 'sessionCoordinator.make.done' },
    { name: 'no rule is on', suggest: false, message: 'sessionCoordinator.make.doneNoRule' },
])('says what the confirmation changed when $name', async ({ suggest, message }) => {
    // Coordinator is derived from the Follow relation: without a rule, Make coordinator only sets the session up.
    getStorage().setState(state => ({ settings: { ...state.settings,
        coordinationCoordinatorSuggestProjectRule: suggest, coordinationCoordinatorSuggestHomeRule: suggest } }));
    enableAction.mockResolvedValue({ ok: true, result: { sessionId: 'coordinator', status: 'configured',
        effects: [{ operation: 'role', status: 'accepted' }] } });
    const closed = vi.fn();
    function Host() {
        const [chrome, setChrome] = React.useState<Parameters<NonNullable<CustomModalInjectedProps['setChrome']>>[0]>(null);
        return <>
            <MakeCoordinatorDialog serverId={serverId} sessionId="coordinator" onClose={closed} setChrome={setChrome} />
            {chrome?.kind === 'card' ? chrome.footer : null}
        </>;
    }
    const screen = await renderScreen(<Host />);
    await act(async () => screen.pressByTestId('make-coordinator-submit'));
    await waitForHomeGovernance(() => expect(closed).toHaveBeenCalledOnce());
    expect(enableAction).toHaveBeenCalledWith('session.coordinator.enable', expect.objectContaining({ sessionId: 'coordinator',
        ruleSuggestions: suggest ? expect.arrayContaining([expect.anything()]) : [] }), expect.anything());
    expect(readPresentationNotice()?.message).toBe(message);
});


it('withholds private Managed by candidates and masks a retained manager without changing the selection', async () => {
    const receiver = createSessionFixture({ id: 'daily-coordinator', serverId, metadata: { name: 'Private daily coordinator', path: '/daily', host: 'test' } });
    const worker = createSessionFixture({ id: 'worker', serverId, origin: { kind: 'none' }, ownerAccountId: 'alice', projectKey: 'payments',
        metadata: { path: '/work/payments', host: 'test', projectId: 'payments' } });
    const coordinator = { ...getStorage().getState().sessions.coordinator!, origin: { kind: 'none' as const }, ownerAccountId: 'alice' };
    getStorage().setState(state => ({ isDataReady: true, sessions: { ...state.sessions, coordinator, [receiver.id]: receiver, [worker.id]: worker },
        sessionListRowsByServerId: { [serverId]: Object.fromEntries([coordinator, worker].map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
        ordinarySessionListMembershipByServerId: { [serverId]: [coordinator.id, worker.id] },
    }));
    for (const session of [coordinator, worker]) {
        homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: {
            ...createPlainSessionByIdResponseFixture(session).session, origin: session.origin, ownerAccountId: session.ownerAccountId,
        } } });
    }
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [coordinator, worker].map(session => ({
            ...createPlainSessionByIdResponseFixture(session).session, origin: session.origin, ownerAccountId: session.ownerAccountId,
            viewer: createSessionOwnerViewerFixture(session),
        })),
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [{
        ruleId: 'daily-rule', version: 1, receiver: { kind: 'session', sessionId: receiver.id },
        content: { t: 'plain', v: { v: 1, enabled: true, policy: { preset: 'important' },
            filter: normalizeSessionListFilterV1({ show: 'sessions', startedBy: ['you'], scope: 'all_accessible', homeServerIds: [serverId] }) } },
    }] } });
    const screen = await renderScreen(<MakeCoordinatorDialog serverId={serverId} sessionId="coordinator" onClose={() => {}} />);
    const managed = () => screen.findAll(node => node.props.testID === 'make-coordinator-managed-by' && Array.isArray(node.props.items))[0];
    await waitForHomeGovernance(() => expect(managed()?.props.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: receiver.id, title: 'Private daily coordinator' }),
    ])));
    const overlap = () => screen.findAll(node => node.props.testID === 'make-coordinator-overlap' && typeof node.props.title === 'string')[0];
    await vi.waitFor(() => expect(overlap()?.props.title).toContain('Private daily coordinator'));
    const selected = managed()!.props.selectedId;
    expect(selected).toBe(receiver.id);
    await act(async () => {
        getStorage().getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
        getStorage().getState().setSessionTagAssignmentsOptimistic(serverId, receiver.id, ['private']);
        setScreenSharingPrivacyActive(true);
    });
    expect(managed()?.props.selectedId).toBe(selected);
    expect(overlap()?.props.title).not.toContain('Private daily coordinator');
    expect(overlap()?.props.title).toContain('sessionCoordinator.make.unknownSession');
    expect(managed()?.props.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Private daily coordinator' })]));
    expect(managed()?.props.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: receiver.id, title: 'sessionCoordinator.make.unknownSession' }),
    ]));
    await act(async () => managed()?.props.onSelect('__none__'));
    expect(managed()?.props.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: receiver.id })]));
    await act(async () => setScreenSharingPrivacyActive(false));
    expect(managed()?.props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: receiver.id, title: 'Private daily coordinator' })]));

    // The HTTP write is still pending when sharing starts; the local notice has not been published yet.
    let releaseWrite = () => {};
    const pendingWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    let written: SetSessionFollowRuleRequestV1 | undefined;
    homes.answer(serverId, '/v2/account/session-follow-rules/daily-rule', {
        select: input => {
            written = SetSessionFollowRuleRequestV1Schema.parse(input);
            return { body: { rule: { ruleId: 'daily-rule', receiver: written.receiver,
                version: written.expectedVersion + 1, content: written.content } }, respondAfter: pendingWrite };
        },
    });
    await act(async () => screen.pressByTestId('make-coordinator-overlap-leave'));
    await waitForHomeGovernance(() => expect(written).toBeDefined());
    expect(written).toMatchObject({ receiver: { kind: 'session', sessionId: receiver.id }, expectedVersion: 1,
        content: { t: 'plain', v: { filter: { projects: { exclude: [{ serverId, projectKey: 'payments' }] } } } } });
    expect(readPresentationNotice()).toBeNull();
    await act(async () => { setScreenSharingPrivacyActive(true); releaseWrite(); });
    await waitForHomeGovernance(() => expect(readPresentationNotice()?.key).toBe('coordinator-overlap:daily-rule'));
    expect(readPresentationNotice()?.emphasis).toBe('sessionCoordinator.make.unknownSession');
    expect(readPresentationNotice()?.message).not.toContain('Private daily coordinator');
    expect(readPresentationNotice()?.message).toContain('sessionCoordinator.make.unknownSession');
});

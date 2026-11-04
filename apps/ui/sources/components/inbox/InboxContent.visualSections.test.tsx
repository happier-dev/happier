import * as React from 'react';
import 'fake-indexeddb/auto';
import { StyleSheet as NativeStyleSheet } from 'react-native';
import { act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionViewerFixture, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createAutomationRunFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { buildInboxItems, type InboxItem } from './inboxItems';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionPresentationRecord, SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { workflowRunRowFromAutomationRun, workflowRunRowFromSummary, type WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { projectSessionContextPresentation } from '@/sync/domains/session/presentation/sessionContextPresentation';
import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';

import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { storage } from '@/sync/domains/state/storageStore';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { UserCard } from '@/components/ui/cards/UserCard';
import { ApprovalInboxCard } from '@/components/inbox/cards/ApprovalInboxCard';
import { InboxSessionAttentionGroupCard } from '@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard';
import { InboxReadySessionRow } from './InboxReadySessionRow';
import { ActionOperationRows } from './actionOperations/ActionOperationLedger';
import { SessionListIdentity } from '@/components/sessions/shell/SessionListIdentity';
import { InboxSessionRowMenu } from './workGroups/InboxSessionRowMenu';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { UserProfileSchema } from '@happier-dev/protocol/social/friends';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { useInboxItemNavigation } from '@/hooks/inbox/useInboxItemNavigation';
import { useInboxItemResolved } from '@/hooks/inbox/useInboxItemResolved';
import type { InboxItemFocus } from './inboxItemFocus';
import type { InboxItemView } from './inboxItems';
import { InboxWorkItemRow } from './workGroups/InboxWorkItemRow';
import { Text } from '@/components/ui/text/Text';
import { InboxWorkRow } from './InboxWorkRow';
import { resolveInboxItemPageRoute } from './inboxItemFocus';
import { readWorkflowRunTarget } from '@/sync/domains/workflows/workflowRunRoute';

const routerPush = vi.hoisted(() => vi.fn());
const viewport = vi.hoisted(() => ({ width: 1024 }));
let heldInvocationId: string | null = null;
const initialStorageState = storage.getState();

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: routerPush },
}).module);
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View',
        useWindowDimensions: () => ({ width: viewport.width, height: 768, scale: 1, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Cold external Socket transport; Account restoration and Action owners stay real.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
function PagePresentation({ children }: React.PropsWithChildren) {
    return <ListPresentationProvider value="page">{children}</ListPresentationProvider>;
}
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function storedSession(id: string, facts: Readonly<{ lead?: string; managedSessions?: number; turn?: Session['latestTurnStatus'] }> = {}): Session {
    return createSessionFixture({
        id,
        serverId: 'server-a',
        encryptionMode: 'plain',
        encryptedContentAvailability: 'ready',
        active: false,
        presence: 'online',
        updatedAt: NOW - 3 * 60_000,
        ...(facts.lead ? { manager: { sessionId: facts.lead } } : {}),
        ...(facts.managedSessions ? { managedSessions: { total: facts.managedSessions, working: 1, needsYou: 1, stalled: 1, finished: 0, attentionPrimary: null } } : {}),
        ...(facts.turn ? { latestTurnStatus: facts.turn } : {}),
        ...(facts.turn === 'failed' ? { viewer: createSessionViewerFixture({
            latestFailureSeq: 4,
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
            attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' },
        }) } : {}),
    });
}

function candidate<T extends SessionPresentationRecord>(session: T, reasons: readonly SessionPersonalAttentionReasonV1[],
    serverId = 'server-a', presentationSource?: SessionListPresentationSource) {
    const presentedSession = { ...session, serverId, viewer: createSessionViewerFixture({ ...session.viewer,
        attention: { needsAttention: reasons.length > 0, reasons: [...reasons], primary: reasons[0] ?? null, presentation: 'full' },
    }) };
    const attention = buildSessionActivityAttention({ session: presentedSession, presentationSource, nowMs: NOW });
    return {
        ...attention,
        title: `Session ${session.id}`,
        subtitle: `/workspace/${session.id}`,
        context: projectSessionContextPresentation({
            address: { serverId, sessionId: session.id }, home: { name: 'Home', serverUrl: null },
            audience: null, responsibility: null, contentAvailability: attention.awareness.encryption,
            workspace: { label: session.id },
            freshness: { state: 'unknown', lastSuccessAt: null, label: null, lastUpdatedLabel: null },
        }),
        route: `/session/${session.id}`,
    };
}

const lead = storedSession('lead', { managedSessions: 3 });
const worker = storedSession('worker', { lead: 'lead' });
const stalledWorker = storedSession('stalled-worker', { lead: 'lead' });
const stopped = storedSession('stopped');
const failed = storedSession('failed', { turn: 'failed' });
const snoozed = storedSession('snoozed');
const sessions = new Map([lead, worker, stalledWorker, stopped, failed, snoozed].map((value) => [value.id, value]));

function createModel(options: Readonly<{
    serverId?: string;
    openApprovals?: ReadonlyArray<Readonly<{ id: string; header: Record<string, unknown> }>>;
    workflowStale?: boolean;
    needsYou?: boolean;
    /** Further runs with no orchestrator, after `library-run`. */
    moreRunIds?: readonly string[];
    /** A run's own state, where it is not the default held `interrupted`. */
    runStates?: Readonly<Record<string, 'cancelled' | 'succeeded' | 'interrupted' | 'waiting_for_review'>>;
    automationRunRows?: readonly WorkflowRunRow[];
    automationServerId?: string;
    /** The step a run's summary says waits, with its lane. */
    heldStep?: Readonly<{ invocationId: string; label: string; laneLabel?: string }>;
    /** Rows other owners contribute to the canonical item model (Discussion mentions, notices). */
    extraItems?: readonly InboxItem[];
}> = {}): InboxModel {
    const needsYou = options.needsYou ?? true;
    const serverId = options.serverId ?? 'server-a';
    const attention = createInboxAttentionFixture(serverId);
    const sessionEntries = needsYou ? [
        // A worker permission prompt and a stopped session's pending request (A17: "Resume").
        { candidate: candidate(worker, ['permission_required'], serverId), pendingPermissions: [{ id: 'p-worker' }], pendingUserActions: [] },
        { candidate: candidate(stopped, ['permission_required'], serverId), pendingPermissions: [{ id: 'p-stopped' }], pendingUserActions: [] },
        { candidate: candidate(failed, ['failed'], serverId), pendingPermissions: [], pendingUserActions: [] },
    ] : [];
    const readySession = storedSession('ready');
    const ready = candidate(readySession, ['unread'], serverId);
    const readyTarget = {
        key: buildServerScopedSessionKey('ready', serverId),
        sessionId: 'ready',
        serverId,
        readState: 'unread',
    };
    const approvals = needsYou ? (options.openApprovals ?? [{ id: 'approval-1', header: {} }]).map(artifact => ({
        id: artifact.id, title: 'Approval', isDecrypted: true as const, header: artifact.header,
        headerVersion: 1, seq: 1, createdAt: NOW - 60_000, updatedAt: NOW - 60_000,
    })) : [];
    const workGroups = buildInboxWorkGroups({
        sessionEntries: sessionEntries as never,
        workflowRuns: needsYou ? ['library-run', ...(options.moreRunIds ?? [])].map((id) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id,
            state: options.runStates?.[id] ?? 'interrupted',
            attentionRequired: (options.heldStep !== undefined && id === 'library-run') || options.runStates?.[id] === 'waiting_for_review',
            invocationAttentionRequired: (options.heldStep !== undefined && id === 'library-run') || options.runStates?.[id] === 'waiting_for_review',
            updatedAt: '2026-09-30T11:54:00.000Z',
            ...(options.heldStep && id === 'library-run' ? { heldStep: options.heldStep } : {}),
        }), null)) : [],
        automationRuns: options.automationRunRows ?? [],
        automationServerId: options.automationServerId ?? serverId,
        openApprovals: approvals as never,
        stalledSessions: needsYou ? [stalledWorker] : [],
        landings: [],
        snoozed: needsYou ? [{ session: snoozed, remindAt: NOW + 3_600_000 }] : [],
        resolveSession: (id) => sessions.get(id),
        resolveOriginRunId: () => null,
    });
    const sessionPresentation = {
        sessionsNeedingAttention: sessionEntries,
        readySessions: [ready],
        markAllReadTargets: [readyTarget],
        pendingRequestHydrationTargets: [],
    };
    const items = [...buildInboxItems({ workGroups, sessionPresentation: sessionPresentation as never,
        workflowServerId: serverId, accountServerId: serverId, notices: [] }), ...(options.extraItems ?? [])];
    return {
        source: { isDataReady: true, sessionsById: Object.fromEntries(sessions), sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
        openApprovals: approvals,
        openUsageNotices: [],
        dismissUsageNotice: vi.fn(async () => {}),
        friendRequests: [UserProfileSchema.parse({ id: 'friend-1', username: 'friend', firstName: 'Friend', lastName: null,
            avatar: null, bio: null, status: 'pending', publicKey: null })],
        sessionPresentation,
        targetBySessionAddress: new Map([[readyTarget.key, readyTarget]]),
        actionOperationEntries: needsYou ? [{
            reason: 'failed',
            operation: { serverId: 'server-a', observation: 'available', isUnavailableProjection: false,
                snapshot: ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'op-failed', revision: 2,
                    actionId: 'session.spawn_new', state: 'failed', scope: { accountId: 'account-a', machineId: 'machine-1' },
                    title: 'Create session', createdAt: NOW - 60_000, startedAt: NOW - 50_000, settledAt: NOW - 30_000, cancellation: 'unsupported',
                    error: { errorCode: 'failed', error: 'Failed' } }),
            },
        }] : [],
        pendingReadKeys: new Set(),
        markAllPending: false,
        isLoading: false,
        hasPrimaryAttention: true,
        showCaughtUp: false,
        markRead: vi.fn(async () => {}),
        resolveActionOperation: vi.fn(),
        workGroups,
        spansHomes: true,
        ...attention,
        items,
        sessionCandidates: [...sessionEntries.map(entry => entry.candidate), ready],
        workflowAttention: options.workflowStale
            ? { ...attention.workflowAttention, available: true, phase: 'loaded', refreshFailed: true,
                runIds: needsYou ? ['library-run'] : [], knownAt: NOW - 60_000 }
            : attention.workflowAttention,
        settle: vi.fn(async () => {}),
        setReminder: vi.fn(async () => {}),
    } as unknown as InboxModel;
}

function scopedByType(tree: ReactTestRenderer, scope: ReactTestInstance, type: unknown) {
    const candidates = new Set(tree.findAllByType(type));
    return scope.findAll(node => candidates.has(node));
}

type Node = { props: Record<string, unknown>; findAll: (predicate: (node: Node) => boolean) => readonly Node[] };

function groupOrder(tree: { root: Node }): string[] {
    return Array.from(new Set(tree.root
        .findAll((node) => typeof node.props.testID === 'string' && /^inbox\.group\.[a-z:_-]+$/.test(node.props.testID))
        .map((node) => String(node.props.testID))));
}

function pressInboxKey(key: string) {
    const event = new Event('keydown', { cancelable: true });
    for (const [name, value] of Object.entries({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, altKey: false, ctrlKey: false,
        metaKey: false, shiftKey: false, repeat: false })) Object.defineProperty(event, name, { value });
    window.dispatchEvent(event);
}

function NavigableInbox(props: Readonly<{ model: InboxModel; view: InboxItemView; content: typeof import('./InboxContent')['InboxContent'] }>) {
    const [focus, select] = React.useState<InboxItemFocus | null>(null);
    const close = React.useCallback(() => select(null), []);
    const selectedResolved = useInboxItemResolved(focus, { sessionCandidates: props.model.sessionCandidates,
        accountNotices: props.model.accountNotices, isDataReady: props.model.source.isDataReady,
        sessionScopes: props.model.source.audienceScopes });
    useInboxItemNavigation({ items: props.model.items, view: props.view, focus, enabled: true,
        selectedResolved, select, open: routerPush, close, markOpened: props.model.markItemOpened });
    const Content = props.content;
    return <><Content model={props.model} view={props.view} focusedItem={focus} onSelectItem={select} />
        <Text testID="inbox.selected">{JSON.stringify(focus)}</Text></>;
}

describe('InboxContent rows, attention sources and popover (ORC R-10, lab inbox-I1, P4)', () => {
    it.each(['screen', 'popover'] as const)('renders Automation-only attention as an Update and never as caught up in the %s', async (presentation) => {
        const { InboxContent } = await import('./InboxContent');
        const onOpenInbox = vi.fn();
        const run = createAutomationRunFixture({ id: 'pre-session', state: 'failed' });
        const route = `/workflows/runs/${run.id}?target=occurrence&automationId=${run.automationId}&serverId=home-b` as const;
        const model = { ...createModel({ needsYou: false, automationServerId: 'home-b', automationRunRows: [workflowRunRowFromAutomationRun(run)] }), friendRequests: [],
            sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
            automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'loaded' as const, runIds: [run.id], knownAt: NOW },
            automationAttentionItems: [{ key: `automation-run:${run.id}`, run, route }],
        };
        // A failed Automation run asks for nothing now: it is an Update, so the page draws its row under
        // Updates and the popover says so in its one Updates line, which opens the Inbox.
        const screen = await renderScreen(<InboxContent model={model} presentation={presentation} view="updates" onOpenInbox={onOpenInbox} />,
            presentation === 'screen' ? { wrapper: PagePresentation } : {});
        expect(screen.findByTestId('inbox.empty')).toBeNull();
        if (presentation === 'screen') {
            const row = screen.findByTestId(`inbox.automation_run.${run.id}`);
            expect(row).not.toBeNull();
            row!.props.onPress();
            expect(routerPush).toHaveBeenCalledWith(route);
        } else {
            expect(screen.findByTestId(`inbox.automation_run.${run.id}`)).toBeNull();
            screen.findByTestId('inbox.popover.updates')!.props.onPress();
            expect(onOpenInbox).toHaveBeenCalledTimes(1);
        }
    });

    it.each(['screen', 'popover'] as const)('does not claim caught up after an initial Automation failure in the %s', async (presentation) => {
        const { InboxContent } = await import('./InboxContent');
        const retry = vi.fn();
        const model = { ...createModel({ needsYou: false }), friendRequests: [],
            sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
            automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'failed' as const, retry },
        };
        const screen = await renderScreen(<InboxContent model={model} presentation={presentation} />);
        expect(screen.findByTestId('inbox.empty')).toBeNull();
        const button = screen.findByTestId('inbox.automation_retry');
        expect(button).not.toBeNull();
        button!.props.onPress();
        expect(retry).toHaveBeenCalledOnce();
    });

    it('retains a stale Automation row and retries its own source, not Workflows', async () => {
        const { InboxContent } = await import('./InboxContent');
        const run = createAutomationRunFixture({ id: 'known-failure', state: 'failed' });
        const retry = vi.fn();
        const workflowRetry = vi.fn();
        const model = { ...createModel({ needsYou: false, automationRunRows: [workflowRunRowFromAutomationRun(run)] }),
            workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, retry: workflowRetry },
            automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'loaded' as const,
                refreshFailed: true, runIds: [run.id], knownAt: NOW - 60_000, retry },
            automationAttentionItems: [{ key: `automation-run:${run.id}`, run,
                route: `/workflows/runs/${run.id}?target=occurrence&automationId=${run.automationId}` as const }],
        };
        // The last-known row stays in Updates; the stale line (Needs you, where attention sources report) retries the source.
        const updates = await renderScreen(<InboxContent model={model} view="updates" />, { wrapper: PagePresentation });
        expect(updates.findByTestId(`inbox.automation_run.${run.id}`)).not.toBeNull();
        await updates.unmount();
        const screen = await renderScreen(<InboxContent model={model} />);
        const stale = screen.findAllByType(SurfaceFreshnessLine).find(node => node.props.testID === 'inbox.automation_stale');
        expect(stale?.props.asOf).toBe(NOW - 60_000);
        stale!.props.action.onPress();
        expect(retry).toHaveBeenCalledOnce();
        expect(workflowRetry).not.toHaveBeenCalled();
    });
    beforeEach(async () => {
        heldInvocationId = null;
        viewport.width = 1024;
        storage.setState({ settings: { ...storage.getState().settings, sessionListIdentityDisplay: 'agentLogo' } });
        routerPush.mockClear();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://server-a', accountId: 'account-a',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json({
                    mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                });
                if (path === '/v3/automations/runs/workflow-storage') {
                    const operation = JSON.parse(String(init?.body)) as { operation: string };
                    if (operation.operation === 'invocations.list') return Response.json({ invocations: heldInvocationId ? [
                        createWorkflowInvocationIndexFixture({ id: heldInvocationId, runId: 'library-run', lifecycle: 'waiting_for_review' }),
                    ] : [], parentRevision: 0 });
                }
                return new Response('{}', { status: 404 });
            },
        });
        vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    });

    it.each([false, true])('keeps the exact Run and Home through mobile and wide navigation (held=%s)', async (held) => {
        const { InboxContent } = await import('./InboxContent');
        heldInvocationId = held ? 'held/step' : null;
        const model = createModel();
        const hosted = { ...model, workflowAttention: { ...model.workflowAttention, serverId: 'server-a' } };
        const routes: string[] = [];
        for (const width of [390, 1440]) {
            viewport.width = width;
            const selected: InboxItemFocus[] = [];
            const screen = await renderScreen(<InboxContent model={hosted} view="updates"
                {...(width > 390 ? { onSelectItem: (focus: InboxItemFocus) => selected.push(focus) } : {})} />);
            await screen.pressByTestIdAsync('inbox.run.library-run');
            await vi.waitFor(() => expect(width === 390 ? routerPush.mock.calls.length : selected.length).toBeGreaterThan(0));
            const route = width === 390 ? String(routerPush.mock.calls.at(-1)?.[0]) : resolveInboxItemPageRoute(selected[0]!);
            routes.push(route);
            const url = new URL(route, 'https://app.test');
            expect(url.searchParams.get('serverId')).toBe('server-a');
            expect(url.searchParams.get('invocationId')).toBe(heldInvocationId);
            expect(readWorkflowRunTarget({ runId: decodeURIComponent(url.pathname.split('/').at(-1)!), ...Object.fromEntries(url.searchParams) }))
                .toEqual({ kind: 'managed', runId: 'library-run' });
            await screen.unmount();
        }
        expect(routes[0]).toBe(routes[1]);
    });

    it('does not rebind another Home\'s Inbox Run to the active Home', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel();
        const screen = await renderScreen(<InboxContent model={{ ...model,
            workflowAttention: { ...model.workflowAttention, serverId: 'other-home' } }} view="updates" />);
        await screen.pressByTestIdAsync('inbox.run.library-run');
        expect(routerPush).not.toHaveBeenCalled();
    });
    afterEach(async () => {
        await standardCleanup();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        await connection?.dispose();
        connection = null;
        storage.setState(initialStorageState, true);
    });

    it('updates an unchanged Automation attention row age on the shared clock and keeps its open target', async () => {
        // Relative-date deadlines use timeouts; keep that genuine clock boundary under fake time too.
        vi.useRealTimers();
        vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        const { InboxContent } = await import('./InboxContent');
        const run = createAutomationRunFixture({ id: 'aging-run', state: 'failed', finishedAt: NOW - 60_000 });
        const route = `/workflows/runs/${run.id}?target=occurrence&automationId=${run.automationId}&serverId=server-a` as const;
        const base = createModel({ needsYou: false, automationRunRows: [workflowRunRowFromAutomationRun(run)] });
        const model = { ...base, automationAttentionItems: [{ key: `automation-run:${run.id}`, run, route }],
            automationAttention: { ...base.automationAttention, available: true, phase: 'loaded' as const, runIds: [run.id] } };
        const screen = await renderScreen(<InboxContent model={model} view="updates" />);
        expect(screen.getTextContent()).toContain('1m');
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(screen.getTextContent()).toContain('2m');
        await screen.pressByTestIdAsync(`inbox.automation_run.${run.id}`);
        expect(routerPush).toHaveBeenCalledWith(route);
        await screen.unmount();
    });

    it('puts Action operations after the type sections in Needs you, and the stalled session with its reason in Updates', async () => {
        const { InboxContent } = await import('./InboxContent');
        const needsYou = await renderScreen(<InboxContent model={createModel()} />, { wrapper: PagePresentation });
        expect(scopedByType(needsYou.tree, needsYou.tree.root.findByProps({ testID: 'inbox.section.operations' }), ActionOperationRows)).toHaveLength(1);
        expect(needsYou.tree.findAllByType(InboxReadySessionRow)).toHaveLength(0);
        await needsYou.unmount();

        const updates = await renderScreen(<InboxContent model={createModel()} view="updates" />, { wrapper: PagePresentation });
        expect(updates.tree.root.findByProps({ testID: 'inbox.stalled.stalled-worker' }).props.facts)
            .toEqual(['inbox.work.rows.stalled', 'inbox.work.rows.stalledReason']);
        // An interrupted run with no held step asks for nothing: it is reviewed from its Updates row.
        await updates.tree.pressByTestIdAsync('inbox.run.library-run.review');
        await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('library-run')));
    });

    it('opens a stopped run rather than offering to review it (DESIGN-14 D8)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent view="updates" model={createModel({
            moreRunIds: ['stopped-run'], runStates: { 'stopped-run': 'cancelled' },
        })} />);

        expect(tree.root.findByProps({ testID: 'inbox.run.library-run.review' }).props.title).toBe('inbox.work.rows.review');
        expect(tree.root.findByProps({ testID: 'inbox.run.stopped-run.review' }).props.title).toBe('inbox.work.groups.openRun');
    });

    it('marks the one item the person came to see (Boards opens the Inbox item, INT §5.1)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { createInboxItemRoute, readInboxItemFocus } = await import('./inboxItemFocus');
        const selectedRows = (tree: { root: Node }) => Array.from(new Set(tree.root
            .findAll((node) => typeof node.props.testID === 'string' && node.props.selected === true)
            .map((node) => String(node.props.testID))));

        const runRoute = createInboxItemRoute({ kind: 'workflow_run', serverId: 'server-a', id: 'library-run' });
        expect(runRoute.pathname).toBe('/inbox');
        const model = createModel();
        const run = await renderScreen(<InboxContent view="updates" model={{ ...model, workflowAttention: { ...model.workflowAttention, serverId: 'server-a' } }} focusedItem={readInboxItemFocus(runRoute.params.item)} />);
        expect(selectedRows(run.tree as never)).toEqual(['inbox.run.library-run']);

        const sessionRoute = createInboxItemRoute({ kind: 'session', serverId: 'server-a', id: 'stalled-worker' });
        const session = await renderScreen(<InboxContent view="updates" model={createModel()} focusedItem={readInboxItemFocus([sessionRoute.params.item])} />);
        expect(selectedRows(session.tree as never)).toEqual(['inbox.stalled.stalled-worker']);

        const none = await renderScreen(<InboxContent view="updates" model={createModel()} />);
        expect(selectedRows(none.tree as never)).toEqual([]);

        const invalid = await renderScreen(<InboxContent view="updates" model={createModel()} focusedItem={readInboxItemFocus('session: ')} />);
        expect(selectedRows(invalid.tree as never)).toEqual([]);
    });

    it('beside its detail pane, a row selects its item instead of leaving the Inbox (lab inbox-I1)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const selected: unknown[] = [];
        const model = createModel({ openApprovals: [{ id: 'approval-1', header: { serverIdentityId: 'server-a' } }] });
        const hosted = { ...model, workflowAttention: { ...model.workflowAttention, serverId: 'server-a' } };
        const updates = await renderScreen(
            <InboxContent model={hosted} view="updates" onSelectItem={(focus) => selected.push(focus)} />,
        );
        updates.tree.root.findByProps({ testID: 'inbox.stalled.stalled-worker' }).props.onPress();
        await updates.tree.pressByTestIdAsync('inbox.run.library-run');
        await updates.unmount();
        const { tree } = await renderScreen(
            <InboxContent model={hosted} onSelectItem={(focus) => selected.push(focus)} />,
        );
        tree.findByType(ApprovalInboxCard).props.onPress();

        await vi.waitFor(() => expect(selected).toEqual([
            { kind: 'session', serverId: 'server-a', id: 'stalled-worker' },
            { kind: 'workflow_run', serverId: 'server-a', id: 'library-run' },
            { kind: 'approval', serverId: 'server-a', id: 'approval-1' },
        ]));
        expect(routerPush).not.toHaveBeenCalled();
    });

    it("keeps a stopped session's pending request in its row as the Resume card (stale request, A17)", async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} />);

        const approvals = tree.root.findByProps({ testID: 'inbox.type.approval' });
        const stoppedCard = scopedByType(tree, approvals, InboxSessionAttentionGroupCard).find((card) => card.props.session.id === 'stopped');
        expect(stoppedCard?.props.permissionRequests).toEqual([{ id: 'p-stopped' }]);
        // Answer controls exist once per request: nowhere else in the Inbox.
        expect(tree.findAllByType(InboxSessionAttentionGroupCard)).toHaveLength(2);
    });

    it('draws a request-carrying session with its sheet-mates\' anatomy: the Inbox session line and its age', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} />);

        const approvals = tree.root.findByProps({ testID: 'inbox.type.approval' });
        const card = scopedByType(tree, approvals, InboxSessionAttentionGroupCard).find((entry) => entry.props.session.id === 'stopped');
        const facts = card?.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.endsWith('.stopped.summary:facts'))[0];
        const textOf = (value: unknown): string => typeof value === 'string' ? value
            : Array.isArray(value) ? value.map(textOf).join('')
                : value && typeof value === 'object' && 'props' in value ? textOf((value as { props: { children?: unknown } }).props.children) : '';
        // One session line (no raw Home segment on a single-Home Inbox) and the row's age, like a plain session row.
        expect(textOf(facts?.props.children)).not.toContain('Home');
        expect(card?.findAll((node) => typeof node.props.timestamp === 'number').length).toBeGreaterThan(0);
    });

    it('shows a snoozed session quietly in Updates with its time and the row menu', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} view="updates" />);

        const row = tree.root.findByProps({ testID: 'inbox.snoozed.snoozed' });
        expect(row.props.facts.join(' · ')).toContain('inbox.work.rows.snoozedUntil');
        expect(scopedByType(tree, row, InboxSessionRowMenu)).toHaveLength(1);
        // It asks for nothing now, so Needs you does not carry it.
        const needsYou = await renderScreen(<InboxContent model={createModel()} />);
        expect(needsYou.tree.root.findAllByProps({ testID: 'inbox.snoozed.snoozed' })).toHaveLength(0);
    });

    it('says once that the workflow input is stale while keeping the last-known rows', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel({ workflowStale: true, heldStep: { invocationId: 'inv-1', label: 'Write changelog' } });
        const { tree } = await renderScreen(<InboxContent model={model} />);

        const line = tree.findByType(SurfaceFreshnessLine);
        expect(line.props.asOf).toBe(NOW - 60_000);
        expect(line.props.action.onPress).toBe(model.workflowAttention.retry);
        expect(tree.root.findByProps({ testID: 'inbox.type.decision' }).findAllByProps({ testID: 'inbox.run.library-run' }).length).toBeGreaterThan(0);
    });

    it.each(['screen', 'popover'] as const)('shows unavailable with retry instead of empty on the %s', async (presentation) => {
        const { InboxContent } = await import('./InboxContent');
        const retry = vi.fn();
        const base = createModel({ needsYou: false });
        const model = { ...base, friendRequests: [],
            sessionPresentation: { ...base.sessionPresentation, readySessions: [], markAllReadTargets: [] },
            hasPrimaryAttention: false, showCaughtUp: false,
            workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'failed' as const,
                refreshFailed: true, retry },
        };
        const { tree, pressByTestId } = await renderScreen(<InboxContent model={model} presentation={presentation} />);

        expect(tree.root.findAllByProps({ testID: 'inbox.empty' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.workflow_stale' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.workflow_unavailable' }).length).toBeGreaterThan(0);
        pressByTestId('inbox.workflow_retry');
        expect(retry).toHaveBeenCalledOnce();
    });

    it('keeps an empty stale workflow list truthful instead of adding a caught-up state', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel({ needsYou: false, workflowStale: true });
        const { tree } = await renderScreen(<InboxContent model={model} />);
        expect(tree.root.findAllByProps({ testID: 'inbox.empty' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.workflow_unavailable' }).length).toBeGreaterThan(0);
    });

    it('keeps finished sessions and people in Updates, with mark-all as that section action', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel();
        const { tree, pressByTestId } = await renderScreen(<InboxContent model={model} view="updates" />, { wrapper: PagePresentation });

        expect(groupOrder(tree as never)).toEqual([]);
        expect(tree.findAllByType(InboxReadySessionRow)).toHaveLength(1);
        expect(tree.findAllByType(UserCard)).toHaveLength(1);
        pressByTestId('inbox.ready.mark_all_read');
        expect(model.markRead).toHaveBeenCalledWith(model.sessionPresentation.markAllReadTargets);
    });

    it('shows the calm empty Needs you state with no action when nothing waits on the person', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel({ needsYou: false })} />);

        // Updates still hold a finished session, so this is "Nothing needs you", not "all caught up".
        const empty = tree.findByType(EmptyState);
        expect(empty.props.title).toBe('inbox.work.empty.title');
        expect(empty.props.layout).toBe('page');
        expect(empty.props.primaryAction).toBeUndefined();
    });

    it('keeps the popover flat: Needs you types inline, Updates as one line', async () => {
        const { InboxContent } = await import('./InboxContent');
        const onOpenInbox = vi.fn();
        const { tree } = await renderScreen(
            <InboxContent model={createModel({ heldStep: { invocationId: 'inv-1', label: 'Write changelog' } })} presentation="popover" onOpenInbox={onOpenInbox} />,
        );

        expect(tree.findAllByType(ItemGroup)).toHaveLength(0);
        const typeSections = Array.from(new Set(tree.root
            .findAll((node) => typeof node.props.testID === 'string' && /^inbox\.type\.[a-z_]+$/.test(String(node.props.testID)))
            .map((node) => String(node.props.testID))));
        expect(typeSections).toEqual(['inbox.type.approval', 'inbox.type.decision']);
        expect(groupOrder(tree as never)).toEqual([]);
        // What asks for nothing now is one line to Updates, not rows.
        expect(tree.root.findAllByProps({ testID: 'inbox.stalled.stalled-worker' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.session.failed' })).toHaveLength(0);
        tree.root.findByProps({ testID: 'inbox.popover.updates' }).props.onPress();
        expect(onOpenInbox).toHaveBeenCalledTimes(1);
    });

    it('gives a popover row its title’s full width: kind and age on the line beneath and the answer inline (lab inbox-I2, phone-P4)', async () => {
        const { InboxContent } = await import('./InboxContent');
        // A run waiting for review is a decision, so the popover draws it.
        const { tree } = await renderScreen(<InboxContent model={createModel({ runStates: { 'library-run': 'waiting_for_review' } })}
            presentation="popover" onOpenInbox={vi.fn()} />);

        const runRow = tree.root.findByProps({ testID: 'inbox.run.library-run' });
        // Every row here needs the person: no state column and no state word compete with the title;
        // the line beneath says what it is and how long it has waited ("Workflow run · 8m").
        expect(runRow.findAllByProps({ testID: 'inbox.run.library-run.summary:state:label' })).toHaveLength(0);
        const facts = tree.findHostByTestId('inbox.run.library-run.summary:facts')!;
        expect(facts.props.numberOfLines).toBe(1);
        const textOf = (value: unknown): string => typeof value === 'string' ? value
            : Array.isArray(value) ? value.map(textOf).join('')
                : value && typeof value === 'object' && 'props' in value ? textOf((value as { props: { children?: unknown } }).props.children) : '';
        const line = textOf(facts.props.children);
        expect(line).toContain('inbox.work.rows.workflowRun');
        expect(line).not.toContain('workflows.runState');
        // The age rides at the end of that line, not in a trailing column.
        // (the bundler may suffix the component's name)
        expect(facts.findAll((node) => typeof node.type === 'function' && /^InboxRelativeTime\d*$/.test(node.type.name)).length).toBeGreaterThan(0);
        expect(tree.root.findByProps({ testID: 'inbox.run.library-run.review' })).toBeTruthy();
    });

    it('names the step a held run waits on and its lane under the run (lab inbox-I1, DESIGN-15 R5)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel({
            heldStep: { invocationId: 'inv-changelog', label: 'Write changelog', laneLabel: 'Changelog' },
        })} />);
        const facts = tree.findHostByTestId('inbox.run.library-run.summary:facts')!;
        const textOf = (value: unknown): string => typeof value === 'string' ? value
            : Array.isArray(value) ? value.map(textOf).join('')
                : value && typeof value === 'object' && 'props' in value ? textOf((value as { props: { children?: unknown } }).props.children) : '';
        const line = textOf(facts.props.children);
        expect(line).toContain('workflows.run.attentionWaitRow');
        expect(line).toContain('Changelog');
        // The line already says it waits for you; the state column does not say it again (DESIGN-16 D8).
        expect(tree.findHostByTestId('inbox.run.library-run.summary:state:label')).toBeNull();
    });

    it('opens a V2 approval through its portable owning Home rather than the focused Home', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel({
            openApprovals: [{
                id: 'approval-home-b',
                header: { serverId: 'creator-local-b', serverIdentityId: 'stable-home-b' },
            }],
        });
        const { tree } = await renderScreen(<InboxContent model={model} />);

        tree.findByType(ApprovalInboxCard).props.onPress();

        expect(routerPush).toHaveBeenCalledWith('/inbox/approvals/approval-home-b?serverId=stable-home-b');
    });

    it("states each row's word and tone through the shared work-status owner (INT §5.3), never a local rule", async () => {
        const { InboxContent } = await import('./InboxContent');
        const { resolveWorkStatusTone } = await import('@/components/work/status/resolveWorkStatusTone');
        const { readSessionWorkStatusFacts } = await import('@/components/work/status/sessionWorkStatusFacts');
        const { workStatusWordStyle } = await import('@/components/work/status/workStatusTreatment');
        const { describeWorkflowRunState } = await import('@/components/workflows/presentation/workflowLifecyclePresentation');
        const { readWorkflowRunWorkStatusFacts } = await import('@/components/work/status/workflowWorkStatusFacts');
        const model = createModel();
        const { tree } = await renderScreen(<InboxContent model={model} view="updates" />);

        // A failed session: the Session owner's word, in the resolver's danger tone.
        const failedStatus = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(failed, NOW) });
        expect(failedStatus.tone).toBe('danger');
        const failedWord = tree.findHostByTestId('inbox.session.failed.summary:state:label')!;
        expect(failedWord.props.children).toBe(failedStatus.word);
        expect(NativeStyleSheet.flatten(failedWord.props.style).color).toBe(workStatusWordStyle('danger').color);
        expect(tree.findHostByTestId('inbox.session.failed.summary:facts')!.findAll((node) => node.props.children === failedStatus.word)).toHaveLength(0);

        // Updates retains the Run owner's state and tone; C1 admission alone chooses Needs you membership.
        const run = model.workGroups.flatMap(group => group.items).find(item => item.kind === 'workflow_run');
        if (run?.kind !== 'workflow_run' || !run.row.summary) throw new Error('Expected the held Run summary');
        const runStatus = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(run.row.summary) });
        expect(runStatus.attentionType).toBeNull();
        const runRow = tree.root.findByProps({ testID: 'inbox.run.library-run' });
        expect(runRow.props.title).not.toBe(describeWorkflowRunState('interrupted').label);
        const runWord = tree.findHostByTestId('inbox.run.library-run.summary:state:label')!;
        expect(runWord.props.children).toBe(runStatus.word);
        expect(NativeStyleSheet.flatten(runWord.props.style).color).toBe(workStatusWordStyle(runStatus.tone).color);

        // A stalled worker: its Session word beside the row's own explanation.
        const stalledStatus = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(stalledWorker, NOW) });
        const stalledWord = tree.findHostByTestId('inbox.stalled.stalled-worker.summary:state:label')!;
        expect(stalledWord.props.children).toBe(stalledStatus.word);
        expect(NativeStyleSheet.flatten(stalledWord.props.style).color).toBe(workStatusWordStyle(stalledStatus.tone).color);
    });

    it('states a finished session in Updates with its own word, healthy and neutral', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} view="updates" />);

        const row = tree.findByType(InboxReadySessionRow);
        // The Session owner's word replaces the Inbox-local "Ready for review" status.
        expect(row.props.statusTone).toBe('neutral');
        expect(typeof row.props.statusWord).toBe('string');
        expect(String(row.props.subtitle)).not.toContain('status.readyForReview');
    });

    it('removes the leading slot when the canonical Session-list identity preference is none', async () => {
        storage.setState({ settings: { ...storage.getState().settings, sessionListIdentityDisplay: 'none' } });
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} view="updates" />);

        const failedRow = tree.root.findByProps({ testID: 'inbox.session.failed' });
        // A failed session keeps its failure glyph; identity marks follow the preference.
        expect(scopedByType(tree, failedRow, SessionListIdentity)).toHaveLength(0);
    });
});

function mentionItem(id: string): InboxItem {
    const focus = { kind: 'discussion', serverId: 'server-a', id: 'disc-1', messageId: id } as const;
    return { key: `discussion:server-a:disc-1:${id}`, producer: 'live', type: 'mention', view: 'mentions',
        title: 'Retry cap during deploys', context: null, createdAt: NOW - 120_000, read: false, focus,
        pageRoute: `/discussions/disc-1`, source: { kind: 'discussion', id: 'disc-1', serverId: 'server-a' } };
}

describe('InboxContent renders the canonical item model in three views (C1 L10, lab P4)', () => {
    afterEach(async () => {
        standardCleanup(); vi.unstubAllGlobals();
        await connection?.dispose(); connection = null;
        storage.setState(initialStorageState, true);
    });
    it('groups Needs you by type — Approvals, Decisions, Blocked — never by work root', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel({ heldStep: { invocationId: 'inv-1', label: 'Write changelog' } });
        const { tree } = await renderScreen(<InboxContent model={model} />, { wrapper: PagePresentation });

        const typeSections = Array.from(new Set(tree.root
            .findAll((node) => typeof node.props.testID === 'string' && /^inbox\.type\.[a-z_]+$/.test(String(node.props.testID)))
            .map((node) => String(node.props.testID))));
        expect(typeSections).toEqual(['inbox.type.approval', 'inbox.type.decision']);
        expect(groupOrder(tree as never)).toEqual([]);
        const approvals = tree.root.findByProps({ testID: 'inbox.type.approval' });
        // The worker's and the stopped session's prompts keep their answer cards; the open approval its card.
        expect(scopedByType(tree, approvals, InboxSessionAttentionGroupCard).map((card) => card.props.session.id)).toEqual(['worker', 'stopped']);
        expect(scopedByType(tree, approvals, ApprovalInboxCard)).toHaveLength(1);
        const decisions = tree.root.findByProps({ testID: 'inbox.type.decision' });
        expect(decisions.findAllByProps({ testID: 'inbox.run.library-run' }).length).toBeGreaterThan(0);
        // What asks for nothing now (stalled, snoozed, a failed turn) is not in Needs you.
        expect(tree.root.findAllByProps({ testID: 'inbox.stalled.stalled-worker' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.snoozed.snoozed' })).toHaveLength(0);
    });

    it('says where an item comes from on its one line, unless its title already says it', async () => {
        const { InboxContent } = await import('./InboxContent');
        const named = (id: string, title: string): InboxItem => {
            const item = mentionItem(id);
            return { ...item, title, source: { ...item.source, displayName: 'Release planning' } };
        };
        const model = createModel({ extraItems: [named('m-1', 'Retry cap during deploys'), named('m-2', 'Release planning')] });
        const screen = await renderScreen(<InboxContent model={model} view="mentions" />, { wrapper: PagePresentation });
        const facts = (id: string) => screen.findByTestId(`inbox.item.discussion:server-a:disc-1:${id}`)!.props.accessibilityLabel as string;
        expect(facts('m-1')).toContain('Release planning');
        expect(facts('m-2').match(/Release planning/g)).toHaveLength(1);
    });

    it('shows Mentions as their own view, each opening its item, with a calm empty state when none', async () => {
        const { InboxContent } = await import('./InboxContent');
        const onSelectItem = vi.fn();
        const model = createModel({ extraItems: [mentionItem('m-1')] });
        const screen = await renderScreen(<InboxContent model={model} view="mentions" onSelectItem={onSelectItem} />, { wrapper: PagePresentation });
        const row = screen.findByTestId('inbox.item.discussion:server-a:disc-1:m-1');
        expect(row).not.toBeNull();
        row!.props.onPress();
        expect(onSelectItem).toHaveBeenCalledWith(mentionItem('m-1').focus);
        expect(screen.findByTestId('inbox.empty')).toBeNull();
        await screen.unmount();

        const empty = await renderScreen(<InboxContent model={createModel()} view="mentions" />, { wrapper: PagePresentation });
        expect(empty.tree.findByType(EmptyState).props.title).toBe('inbox.work.mentionsEmpty.title');
    });

    it('walks and auto-advances the mounted Needs-you order across work groups and request types', async () => {
        const { InboxContent } = await import('./InboxContent');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://server-a', accountId: 'account-a' });
        const serverId = (await import('@/sync/domains/server/serverRuntime')).getActiveServerSnapshot().serverId;
        vi.stubGlobal('window', new EventTarget());
        vi.stubGlobal('navigator', { platform: 'Linux' });
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: true } });
        const base = createModel({ serverId, heldStep: { invocationId: 'inv-order', label: 'Review result' } });
        const decision = base.items.find(item => item.type === 'decision')!;
        const approvals = base.items.filter(item => item.type === 'approval');
        const model = { ...base, items: [decision, ...base.items.filter(item => item !== decision)], markItemOpened: async () => {} };
        const render = (value: InboxModel) => <KeyboardShortcutProvider handlers={{}}>
            <NavigableInbox model={value} view="needs_you" content={InboxContent} />
        </KeyboardShortcutProvider>;
        const screen = await renderScreen(render(model), { wrapper: PagePresentation });
        const expected = [...approvals, decision];
        expect(screen.tree.findAllByType(InboxWorkItemRow).map(node => node.props.item.key)).toEqual(expected.map(item => item.key));
        for (const item of expected) {
            await act(async () => pressInboxKey('ArrowDown'));
            expect(screen.findByTestId('inbox.selected')?.props.children).toBe(JSON.stringify(item.focus));
        }
        for (const item of expected.slice(0, -1).reverse()) {
            await act(async () => pressInboxKey('k'));
            expect(screen.findByTestId('inbox.selected')?.props.children).toBe(JSON.stringify(item.focus));
        }
        await screen.update(render({ ...model, items: model.items.filter(item => item.key !== expected[0]!.key),
            sessionCandidates: model.sessionCandidates.map(entry => entry.sessionId === expected[0]!.focus.id
                ? candidate(entry.session, [], serverId, entry.presentationSource) : entry) }));
        expect(screen.findByTestId('inbox.selected')?.props.children).toBe(JSON.stringify(expected[1]!.focus));
    });

    it.each(['updates', 'mentions'] as const)('walks the mounted %s in descending arrival time', async view => {
        const { InboxContent } = await import('./InboxContent');
        vi.stubGlobal('window', new EventTarget());
        vi.stubGlobal('navigator', { platform: 'Linux' });
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: true } });
        const rows = [mentionItem('older'), mentionItem('newer'), mentionItem('middle')].map((item, index) => ({
            ...item, type: view === 'updates' ? 'update' as const : 'mention' as const, view,
            createdAt: NOW - [90_000_000, 1_000, 60_000][index]!,
        }));
        const model = { ...createModel({ needsYou: false }), items: rows, markItemOpened: async () => {} };
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}>
            <NavigableInbox model={model} view={view} content={InboxContent} />
        </KeyboardShortcutProvider>, { wrapper: PagePresentation });
        const expected = [rows[1]!, rows[2]!, rows[0]!];
        expect(screen.tree.findAllByType(InboxWorkRow).map(node => node.props.testID))
            .toEqual(expected.map(item => `inbox.item.${item.key}`));
        for (const item of expected) {
            await act(async () => pressInboxKey('j'));
            expect(screen.findByTestId('inbox.selected')?.props.children).toBe(JSON.stringify(item.focus));
        }
    });

    it('dismisses any stored notice from its own row through the shared notice owner (C1 M4)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const notices = (['update', 'decision'] as const).map((type) => {
            const artifact = createAccountNoticeArtifactFixture({ id: `notice-${type}`, createdAt: NOW - 60_000,
                header: { type, page: undefined, title: `Notice ${type}`, body: 'Plain words' } });
            return { artifact, header: AccountNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) };
        });
        const base = createModel({ needsYou: false });
        const sessionPresentation = { ...base.sessionPresentation, readySessions: [], markAllReadTargets: [] };
        const dismissAccountNotice = vi.fn(async () => {});
        const items = buildInboxItems({ workGroups: [], sessionPresentation: sessionPresentation as never,
            workflowServerId: 'server-a', accountServerId: 'server-a', notices });
        const model = { ...base, sessionPresentation, friendRequests: [], items, accountNotices: notices, openAccountNotices: notices,
            dismissAccountNotice } as InboxModel;
        for (const [view, notice] of [['updates', notices[0]!], ['needs_you', notices[1]!]] as const) {
            const screen = await renderScreen(<InboxContent model={model} view={view} />, { wrapper: PagePresentation });
            const item = items.find((row) => row.source.id === notice.artifact.id)!;
            const dismiss = screen.findByTestId(`inbox.item.${item.key}.dismiss`);
            expect(dismiss).not.toBeNull();
            await act(async () => { await dismiss!.props.onPress(); });
            expect(dismissAccountNotice).toHaveBeenLastCalledWith(notice);
            await screen.unmount();
        }
        // Live owners keep their own quick actions; a session row gains no notice Dismiss.
        const plain = await renderScreen(<InboxContent model={createModel({ extraItems: [mentionItem('m-2')] })} view="mentions" />, { wrapper: PagePresentation });
        expect(plain.findByTestId('inbox.item.discussion:server-a:disc-1:m-2.dismiss')).toBeNull();
    });

    it('lists Updates newest first: finished sessions, what stopped asking, and people', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} view="updates" />, { wrapper: PagePresentation });
        expect(tree.findAllByType(InboxReadySessionRow)).toHaveLength(1);
        expect(tree.root.findAllByProps({ testID: 'inbox.stalled.stalled-worker' }).length).toBeGreaterThan(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.snoozed.snoozed' }).length).toBeGreaterThan(0);
        expect(tree.findAllByType(UserCard)).toHaveLength(1);
    });
});

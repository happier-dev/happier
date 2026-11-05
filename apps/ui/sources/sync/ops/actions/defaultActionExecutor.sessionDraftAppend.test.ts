import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildUiActionDispatchRequestV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema, type SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceAction } from '@/components/appShell/workspace/workspaceState';
import type { AppWindowRecord } from '@/desktop/window/appWindowBoot';

const native = vi.hoisted(() => ({ label: 'main',
    listeners: new Map<string, Set<(payload: unknown) => void>>(),
    forwarded: [] as Array<Record<string, unknown>>,
    beforeForward: undefined as (() => void) | undefined,
    holdResultListener: undefined as Promise<void> | undefined,
    records: [] as AppWindowRecord[],
}));
// Human approval presentation is an external interaction; unexpected questions are declined.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: false }).module);
// Separate renderer labels and Tauri events are the process boundary. All Action and draft owners run for real.
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    getDesktopHostWindowLabel: () => native.label,
    isDesktopHost: () => true,
    // The native role boundary disables background projection; Action ingress remains mounted.
    useDesktopHostRoleAvailability: () => null,
    getDesktopHostAvailability: async () => ({ windows: { kind: 'available' } }),
    invokeDesktopHost: async (command: string, args: { payload: Record<string, unknown> }) => {
        if (command === 'desktop_app_window_restore') return native.records;
        if (command === 'desktop_window_emit_action') {
            native.forwarded.push(args.payload);
            native.beforeForward?.();
            native.label = String(args.payload.targetWindowLabel ?? 'main');
            native.listeners.get('desktopWindow://action')?.forEach(listener => listener(args.payload));
        } else if (command === 'desktop_window_emit_action_result') {
            native.label = 'main';
            native.listeners.get('desktopWindow://action-result')?.forEach(listener => listener(args.payload));
        }
    },
    listenDesktopHostEvent: async (event: string, listener: (payload: unknown) => void) => {
        if (event === 'desktopWindow://action-result' && native.holdResultListener) {
            const held = native.holdResultListener; native.holdResultListener = undefined;
            await held;
        }
        const listeners = native.listeners.get(event) ?? new Set();
        native.listeners.set(event, listeners); listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createAppShellAction } = await import('./appShellAction');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { registerDesktopAppWindowWorkspace } = await import('@/desktop/window/appWindowRuntime');
const { registerDesktopAppWindowActionResponder } = await import('./desktopAppWindowActionDispatch');
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
const { resetSessionDraftValueCachesForTests } = await import('@/dev/testkit/sessionDraftRepositoryTestkit');
const { writeExistingSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { createExistingSessionComposerDocumentOwner } = await import('@/components/sessions/composer/existingSessionComposerDocumentOwner');
const { readComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const actionId = 'session.draft.append';
const executor = () => createDefaultActionExecutor();

beforeEach(async () => {
    storage.setState(originalState, true);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Draft destination', serverUrl: 'https://draft-destination.test', accountId: 'alice' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://draft-destination.test', accountId: 'alice',
        request: createSessionReadBatchFetchBoundary(homes.request) });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    storage.getState().clearSessionLocalStateScope();
    storage.getState().activateSessionLocalStateScope({ serverId, accountId: 'alice' });
    resetSessionDraftValueCachesForTests();
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { drafts: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    let remoteDraft: SessionDraftRecordV2 | null = null;
    homes.answer(serverId, '/v2/account/session-drafts/read', { select: () => ({ body: remoteDraft
        ? { status: 'present', record: remoteDraft } : { status: 'absent' } }) });
    homes.answer(serverId, '/v2/account/session-drafts/list', { select: () => ({ body: { items: remoteDraft ? [remoteDraft] : [] } }) });
    for (const epoch of ['v1', 'v2']) homes.answer(serverId, `/${epoch}/account/session-drafts/mutate`, { select: input => {
        const request = SessionDraftMutateRequestV2Schema.parse(input);
        remoteDraft = { address: request.address, content: request.content,
            revision: (remoteDraft?.revision ?? 0) + 1, createdAt: 1, updatedAt: 2 };
        return { body: SessionDraftMutateResponseV2Schema.parse({ status: 'updated', record: remoteDraft }) };
    } });
    installSessionActionFixture({ homes, storage, serverId, session: { id: 'lead' } });
    // The Home acknowledges the tuple it was asked to commit: each version advances by exactly one.
    homes.answer(serverId, 'PATCH /v2/sessions/lead', { select: input => {
        const patch = input as { mode: string; source?: { metadata: { version: number }; agentState: { version: number } };
            sharedMetadata?: { expectedVersion: number }; agentState?: { expectedVersion: number } };
        const metadata = patch.mode === 'owner_migration' ? patch.source!.metadata.version : patch.sharedMetadata!.expectedVersion;
        const agentState = patch.mode === 'owner_migration' ? patch.source!.agentState.version : patch.agentState!.expectedVersion;
        return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: metadata + 1 }, agentState: { version: agentState + 1 } } };
    } });
});
afterEach(async () => {
    await standardCleanup();
    native.label = 'main'; native.forwarded.length = 0; native.listeners.clear(); native.beforeForward = undefined; native.records = [];
    native.holdResultListener = undefined;
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    resetSessionDraftValueCachesForTests();
    storage.setState(originalState, true);
});

describe('Session draft append through the real Action executor', () => {
    it('treats person overlay typing as direct composer input even when UI Actions require approval', async () => {
        const scope = { serverId, accountId: 'alice' };
        const ref = { kind: 'session' as const, sessionId: 'lead' };
        writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Draft' } });
        await homes.requireUiApproval(serverId, 'composer.transaction.apply');
        native.records = [{ windowId: 'person-draft', layoutId: 'person-draft', homeId: serverId,
            accountId: scope.accountId, selectedAddress: ref }];
        const state = createWorkspaceState({ id: 'person-session', target: { kind: 'session', params: { id: 'lead', ...scope } },
            pinned: false, preview: false, presentation: { windowId: 'person-draft' } });
        const releasePlacement = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        native.label = 'destination_person-draft';
        const stopResponder = await registerDesktopAppWindowActionResponder();
        const composer = createExistingSessionComposerDocumentOwner({ scope, ref });
        const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
        const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const releaseComposer = registerSessionComposerPresentationTarget({ serverId, sessionId: ref.sessionId }, {
            readScope: () => scope, readRevision: () => composer.read().revision,
            readSnapshot: () => projectComposerDocumentSnapshot({ owner: composer, attachmentCatalog: { entriesById: null },
                presentation: { layout: 'wrap', focused: true, editable: true, submittable: true, submitting: false, running: false } }),
            replace: () => composer.read().revision,
            commitDocument: ({ expectedRevision, mutation }) => composer.apply(expectedRevision, mutation),
            commitDocumentEmitsChange: true,
        });
        const realms: string[] = [];
        const stopObserving = composer.observe(() => realms.push(native.label));
        native.label = 'main';
        const { DesktopActivityOverlayRuntimeShared } = await import('@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime.shared');
        const { executeDesktopActivityOverlayAction } = await import('@/activity/adapters/desktop/runtime/desktopActivityOverlayActions');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear(); vi.mocked(Modal.confirm).mockClear();
        await renderScreen(React.createElement(DesktopActivityOverlayRuntimeShared));
        try {
            native.label = 'activity_overlay';
            let result: unknown;
            await act(async () => { result = await executeDesktopActivityOverlayAction({ ...scope,
                request: buildUiActionDispatchRequestV1({ actionId: 'composer.transaction.apply',
                    input: { scope, ref, transaction: { expectedRevision: composer.read().revision,
                        operations: [{ kind: 'text.insert', position: { offset: 5 }, text: ' typed by person' }] } },
                    context: { surface: 'ui', authority: 'present_user' } }) }); });
            expect(composer.read().document.text, JSON.stringify(result)).toBe('Draft typed by person');
            expect(result).toMatchObject({ ok: true, result: { status: 'applied' } });
            expect(realms).toEqual(['destination_person-draft']);
            expect(native.forwarded.filter(request => request.targetWindowLabel === 'destination_person-draft')).toHaveLength(1);
            expect(homes.artifacts(serverId).list()).toHaveLength(0);
            expect(Modal.show).not.toHaveBeenCalled(); expect(Modal.confirm).not.toHaveBeenCalled();
            await homes.requireActionApproval(serverId, 'composer.transaction.apply', 'agent');
            native.label = 'activity_overlay';
            let agentResult: unknown;
            await act(async () => { agentResult = await executeDesktopActivityOverlayAction({ ...scope,
                request: buildUiActionDispatchRequestV1({ actionId: 'composer.transaction.apply',
                    input: { scope, ref, transaction: { expectedRevision: composer.read().revision,
                        operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'Agent proposal: ' }] } },
                    context: { surface: 'agent', authority: 'account_automation', actionRequestId: 'agent-composer-proposal' } }) }); });
            expect(agentResult, JSON.stringify(agentResult)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(homes.artifacts(serverId).list()).toHaveLength(1);
            expect(composer.read().document.text).toBe('Draft typed by person');
            expect(native.forwarded.filter(request => request.targetWindowLabel === 'destination_person-draft')).toHaveLength(1);
        } finally {
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            stopObserving(); releaseComposer(); stopResponder(); releasePlacement();
        }
    });

    it('delivers an actual activity-overlay request through the mounted main ingress once to the window composer', async () => {
        const scope = { serverId, accountId: 'alice' };
        writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Existing draft' } });
        native.records = [{ windowId: 'overlay-draft', layoutId: 'overlay-draft', homeId: serverId,
            accountId: scope.accountId, selectedAddress: { kind: 'session', sessionId: 'lead' } }];
        const state = createWorkspaceState({ id: 'overlay-session', target: { kind: 'session', params: { id: 'lead', ...scope } },
            pinned: false, preview: false, presentation: { windowId: 'overlay-draft' } });
        const releasePlacement = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        native.label = 'destination_overlay-draft';
        const stopResponder = await registerDesktopAppWindowActionResponder();
        const composer = createExistingSessionComposerDocumentOwner({ scope, ref: { kind: 'session', sessionId: 'lead' } });
        const observedRealms: string[] = [];
        const stopObserving = composer.observe(() => observedRealms.push(native.label));
        native.label = 'main';
        const { DesktopActivityOverlayRuntimeShared } = await import('@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime.shared');
        const { executeDesktopActivityOverlayInteractionWithResult } = await import('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntimeShared));
        try {
            native.label = 'activity_overlay';
            await act(async () => {
                await executeDesktopActivityOverlayInteractionWithResult({ requestId: 'overlay-edit', actionIdentifier: RPC_METHODS.UI_ACTION_EXECUTE,
                    data: { serverId, accountId: scope.accountId, request: buildUiActionDispatchRequestV1({ actionId,
                        input: { sessionId: 'lead', text: 'From the overlay' }, context: { surface: 'ui', authority: 'present_user' } }) } });
            });
            expect(composer.read().document.text).toBe('Existing draft\n\nFrom the overlay');
            expect(observedRealms).toEqual(['destination_overlay-draft']);
            expect(native.forwarded).toHaveLength(2);
            expect(native.forwarded[0]).toMatchObject({ windowLabel: 'activity_overlay', actionIdentifier: RPC_METHODS.UI_ACTION_EXECUTE });
            expect(native.forwarded[1]).toMatchObject({ windowLabel: 'main', targetWindowLabel: 'destination_overlay-draft' });
        } finally {
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            stopObserving(); stopResponder(); releasePlacement();
        }
    });

    it('watches only the addressed window draft, publishes one changed replica, and releases on overlay retarget', async () => {
        const scope = { serverId, accountId: 'alice' };
        writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Initial watched draft' } });
        native.records = [{ windowId: 'watched-draft', layoutId: 'watched-draft', homeId: serverId,
            accountId: scope.accountId, selectedAddress: { kind: 'session', sessionId: 'lead' } }];
        const state = createWorkspaceState({ id: 'watched-session', target: { kind: 'session', params: { id: 'lead', ...scope } },
            pinned: false, preview: false, presentation: { windowId: 'watched-draft' } });
        const releasePlacement = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        native.label = 'destination_watched-draft';
        const stopResponder = await registerDesktopAppWindowActionResponder();
        native.label = 'main';
        const { DesktopActivityOverlayRuntimeShared } = await import('@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime.shared');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntimeShared));
        const { watchDesktopActivityOverlaySessionDraft } = await import('@/activity/adapters/desktop/runtime/desktopActivityOverlayActions');
        const snapshots: string[] = [];
        let stopWatch: (() => Promise<void>) | undefined;
        try {
            native.label = 'activity_overlay';
            await act(async () => { stopWatch = await watchDesktopActivityOverlaySessionDraft({ ...scope, sessionId: 'lead' },
                snapshot => snapshots.push(snapshot?.text ?? 'unavailable')); });
            expect(snapshots).toEqual(['Initial watched draft']);
            const watchRequest = native.forwarded.find(request => request.actionIdentifier === 'desktop.sessionDraft.watch'
                && request.windowLabel === 'activity_overlay');
            const { emitDesktopWindowActionResult } = await import('@/utils/platform/desktopWindowActionBridge');
            await act(async () => {
                await emitDesktopWindowActionResult({ windowLabel: 'activity_overlay', requestId: String(watchRequest?.requestId),
                    phase: 'admitted', ok: true });
                await emitDesktopWindowActionResult({ windowLabel: 'activity_overlay', requestId: String(watchRequest?.requestId),
                    phase: 'settled', ok: false, errorCode: 'target_unavailable' });
            });
            expect(snapshots).toEqual(['Initial watched draft']);
            const bridgeRequestsBeforeTyping = native.forwarded.length;
            native.label = 'destination_watched-draft';
            await act(async () => {
                writeExistingSessionDraft({ scope, sessionId: 'sibling', patch: { text: 'Unrelated edit' } });
                writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Changed in window' } });
            });
            expect(snapshots).toEqual(['Initial watched draft', 'Changed in window']);
            expect(native.forwarded).toHaveLength(bridgeRequestsBeforeTyping);
            // A returned owner reconstructs the persisted revision, so rebind must not duplicate the document.
            const { prepareSessionDraftWindowTransfer, resumeSessionDraftWindowPresentation } = await import('@/sync/ops/sessionDrafts/sessionDraftWindowTransfer');
            await prepareSessionDraftWindowTransfer({ ...scope, sessionId: 'lead' });
            const revision = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'lead' })?.revision;
            const stopReturned = await resumeSessionDraftWindowPresentation({ ...scope, sessionId: 'lead' });
            expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'lead' })?.revision).toBe(revision);
            await act(async () => {
                native.label = 'main';
                native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
                releasePlacement();
            });
            expect(snapshots).toEqual(['Initial watched draft', 'Changed in window']);
            await act(async () => { writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Changed after return' } }); });
            expect(snapshots).toEqual(['Initial watched draft', 'Changed in window', 'Changed after return']);
            stopReturned();
            await stopWatch?.(); stopWatch = undefined;
            await act(async () => { writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'After retarget' } }); });
            expect(snapshots).toEqual(['Initial watched draft', 'Changed in window', 'Changed after return']);
        } finally {
            await stopWatch?.();
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            stopResponder(); releasePlacement();
        }
    });

    it.each(['abort during listener setup', 'native emit failure'] as const)('releases overlay draft observation after %s', async failure => {
        const { watchDesktopActivityOverlaySessionDraft } = await import('@/activity/adapters/desktop/runtime/desktopActivityOverlayActions');
        const cancellation = new AbortController();
        native.label = 'activity_overlay';
        const setup = createDeferred<void>();
        if (failure === 'abort during listener setup') native.holdResultListener = setup.promise;
        else native.beforeForward = () => {
            if (native.forwarded.at(-1)?.actionIdentifier === 'desktop.sessionDraft.watch') throw new Error('native command refused');
        };
        const snapshots: unknown[] = [];
        const watching = watchDesktopActivityOverlaySessionDraft({ serverId, accountId: 'alice', sessionId: 'lead' },
            snapshot => snapshots.push(snapshot), { signal: cancellation.signal });
        if (failure === 'abort during listener setup') { cancellation.abort(); setup.resolve(); }
        await expect(watching).rejects.toMatchObject({ code: failure === 'abort during listener setup' ? 'cancelled' : 'bridge_emit_failed' });
        expect(native.listeners.get('desktopWindow://action-result')?.size ?? 0).toBe(0);
        expect(snapshots).toEqual([]);
    });

    it.each(['ui', 'agent'] as const)('forwards a %s draft edit once to the actual window composer without re-admission and leaves local typing off IPC', async surface => {
        const scope = { serverId, accountId: 'alice' };
        writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Existing draft' } });
        native.records = [{ windowId: 'draft-window', layoutId: 'draft-window', homeId: serverId,
            accountId: scope.accountId, selectedAddress: { kind: 'session', sessionId: 'lead' } }];
        let state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: 'lead', ...scope } },
            pinned: false, preview: false, presentation: { windowId: 'draft-window' } });
        const dispatch = (action: WorkspaceAction) => { state = reduceWorkspaceState(state, action); };
        const releasePlacement = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        native.label = 'destination_draft-window';
        const stopResponder = await registerDesktopAppWindowActionResponder();
        const composer = createExistingSessionComposerDocumentOwner({ scope, ref: { kind: 'session', sessionId: 'lead' } });
        const observedRealms: string[] = [];
        const stopObserving = composer.observe(() => { observedRealms.push(native.label); });
        try {
            native.label = 'main';
            native.beforeForward = () => storage.getState().applySettingsLocal({
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } } }),
            });
            const input = { sessionId: 'lead', text: 'Overlay edit' };
            const result = surface === 'ui'
                ? await executor().execute(actionId, input,
                    { surface, authority: 'present_user', serverId, runtimeAccountId: 'alice' })
                : (await createUiClientActionReverseHandler({ serverId, accountId: 'alice', isCurrent: () => true })({
                    v: 1, actionId, input, context: { surface, authority: 'account_automation' },
                }, { signal: new AbortController().signal })).execution;
            expect(result).toMatchObject({ ok: true, result: { status: 'appended' } });
            expect(native.forwarded).toHaveLength(1);
            expect(native.forwarded[0]).toMatchObject({ targetWindowLabel: 'destination_draft-window',
                actionIdentifier: 'desktop.clientAction.execute.admitted' });
            expect(composer.read().document.text).toBe('Existing draft\n\nOverlay edit');
            expect(observedRealms).toContain('destination_draft-window');
            const forwardedBeforeTyping = native.forwarded.length;
            native.label = 'destination_draft-window';
            writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Typed in window' } });
            expect(composer.read().document.text).toBe('Typed in window');
            expect(native.forwarded).toHaveLength(forwardedBeforeTyping);
        } finally {
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            stopObserving(); stopResponder(); releasePlacement();
        }
    });

    it('forwards an admitted mounted Work read once to its addressed window owner', async () => {
        const scope = { serverId, accountId: 'alice' };
        native.records = [{ windowId: 'work-window', layoutId: 'work-window', homeId: serverId,
            accountId: scope.accountId, selectedAddress: { kind: 'session', sessionId: 'lead' } }];
        const state = createWorkspaceState({ id: 'work-tab', target: { kind: 'session', params: { id: 'lead', ...scope } },
            pinned: false, preview: false, presentation: { windowId: 'work-window' } });
        const releasePlacement = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        const { projectWork } = await import('@/components/sessions/work/workProjection');
        const { registerMountedWorkReadOwner } = await import('./mountedWorkReadAction');
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [], workflowHeadlineRuns: [],
            managedRuns: [], ownTriggerRunIds: new Set(), describeAgentStatus: () => '', describeProgress: () => '' });
        const readingRealms: string[] = [];
        const releaseOwner = registerMountedWorkReadOwner({ scope, sessionId: 'lead', isCurrent: () => true,
            read: () => { readingRealms.push(native.label); return { projection, transcriptLoaded: true,
                managedRuns: { phase: 'loaded', refreshFailed: false } }; } });
        native.label = 'destination_work-window';
        const stopResponder = await registerDesktopAppWindowActionResponder();
        try {
            native.label = 'main';
            const result = await createUiClientActionReverseHandler({ serverId, accountId: 'alice', isCurrent: () => true })({
                v: 1, actionId: 'session.work.get', input: { sessionId: 'lead' },
                context: { surface: 'agent', authority: 'account_automation' },
            }, { signal: new AbortController().signal });
            expect(result).toMatchObject({ execution: { ok: true, result: {
                status: 'ready', sessionId: 'lead', summary: projection.summary,
            } } });
            expect(readingRealms).toEqual(['destination_work-window']);
            expect(native.forwarded).toHaveLength(1);
        } finally {
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            stopResponder(); releaseOwner(); releasePlacement();
        }
    });

    it('subscribes to the exact returned draft before reacquiring it and releases that subscription', async () => {
        const target = { serverId, accountId: 'alice', sessionId: 'lead' };
        writeExistingSessionDraft({ scope: target, sessionId: target.sessionId, patch: { text: 'Persisted draft' } });
        const { prepareSessionDraftWindowTransfer, resumeSessionDraftWindowPresentation } = await import('@/sync/ops/sessionDrafts/sessionDraftWindowTransfer');
        await prepareSessionDraftWindowTransfer(target);
        let notifications = 0;
        const release = await resumeSessionDraftWindowPresentation(target, () => { notifications++; });
        expect(notifications).toBe(1);
        release();
        writeExistingSessionDraft({ scope: target, sessionId: target.sessionId, patch: { text: 'Returned local edit' } });
        expect(notifications).toBe(1);
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: target.sessionId })?.text).toBe('Returned local edit');
    });

    it('appends through the repository composer owner without a metadata seed or message', async () => {
        const scope = { serverId, accountId: 'alice' };
        writeExistingSessionDraft({ scope, sessionId: 'lead', patch: { text: 'Existing draft' } });
        const result = await executor().execute(actionId, {
            sessionId: 'lead', text: 'From reviewer:\nUse checkpoints.', sourceSessionId: 'lead',
        }, { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
            status: 'appended', sessionId: 'lead', createdAtMs: expect.any(Number),
        } });
        const writes = homes.requestsFor('/v2/sessions/lead').filter(request => request.input != null);
        expect(writes).toHaveLength(0);
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 'lead' })?.text)
            .toBe('Existing draft\n\nFrom reviewer:\nUse checkpoints.');
        expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'lead' })).not.toBeNull();
        expect(homes.requests.some(request => request.path.includes('/messages') && request.input != null)).toBe(false);
    });

    it('refuses disabled draft append before writing destination metadata', async () => {
        storage.getState().applySettingsLocal({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } } }) });
        const result = await executor().execute(actionId, { sessionId: 'lead', text: 'Do not append' },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice' });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(homes.requestsFor('/v2/sessions/lead').filter(request => request.input != null).length).toBe(0);
    });

    it('refuses a retired captured Account without appending under its replacement credentials', async () => {
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await homes.switchAccount(serverId, 'bob');
            expect(account.accountOnlyLifetime.isCurrent()).toBe(false);
            const result = await createActionExecutor(createActionExecutorBoundaryFixture({ appShellAction: createAppShellAction(account) })).execute(actionId,
                { sessionId: 'lead', text: 'Alice draft' },
                { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice' });
            expect(result).toMatchObject({ ok: false });
            expect(homes.requestsFor('/v2/sessions/lead').filter(request => request.input != null).length).toBe(0);
        } finally { account.dispose(); }
    });
});

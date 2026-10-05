import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionSurfaceNoteDocumentV1,
    type SessionBoardLayoutV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    projectSessionBoard,
    type SessionBoardActionOutcome,
    type SessionBoardActionsPort,
    type SessionBoardItemRemoveInput,
    type SessionBoardItemUpsertInput,
    type SessionBoardMutationResult,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';

/**
 * Two retained Details Board tabs, one person.
 *
 * The Details workspace keeps both the generic Board tab and the focused Board
 * tab mounted so their content, scroll position and selected view survive a tab
 * switch. Every mounted `SessionBoardDetailsSurface` also mounted a full
 * interaction layer: two editors over one shared draft, two registrations of the
 * single continuity draft guard, and a hidden card holding stale text that could
 * still answer Save. These tests mount the real continuity owner, the real
 * mounted controller, both real Board panes and the real editor cards, so a
 * green result means only the tab a person is looking at can act.
 */

const editorHarness = vi.hoisted(() => ({
    /** Editor-held input the host has not observed through `onChange` yet. */
    pending: new Map<string, string>(),
    /** Optional native-style request/response delay for `flushPendingChange`. */
    flushBarrier: null as Promise<void> | null,
}));
const alertHarness = vi.hoisted(() => ({
    /** Which unsaved-changes button the person presses. */
    decision: 'save' as 'save' | 'discard' | 'keepEditing',
    prompts: 0,
}));
const retainedPaneHarness = vi.hoisted(() => ({
    companionAvailable: false,
    companionItems: [{ kind: 'widget' as const, widgetId: 'item-1' }],
    companionShow: vi.fn(),
    companionRemoveItem: vi.fn(),
    managePlugin: vi.fn(),
    prepareEncryption: vi.fn(),
    readFullItem: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@react-navigation/native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    useNavigation: () => ({ dispatch: vi.fn() }),
    usePreventRemove: () => undefined,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    // Exercise the real Markdown field through its raw CodeEditor boundary;
    // rich eligibility is unrelated to retained-tab ownership.
    useFeatureEnabled: (featureId: string) => featureId !== 'files.markdownRichEditor',
}));
vi.mock('@/components/sessions/companion/state/useSessionCompanionController', () => ({
    useSessionCompanionController: () => ({
        preference: { items: retainedPaneHarness.companionItems },
        availability: retainedPaneHarness.companionAvailable ? 'ready' : 'unavailable',
        show: retainedPaneHarness.companionShow,
        removeItem: retainedPaneHarness.companionRemoveItem,
    }),
}));
vi.mock('@/components/sessions/companion/presentation/SessionCompanionRevealPort', () => ({
    useSessionCompanionRevealPort: () => ({
        address: { serverId: 'home-1', sessionId: 'session-1' },
        openFullSurface: vi.fn(),
        revealAfterMutation: vi.fn(),
        revealBoardItem: vi.fn(),
    }),
}));
vi.mock('@/components/sessions/presentation/presentationNotices', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/sessions/presentation/presentationNotices')>(),
    publishPresentationNotice: vi.fn(),
}));
vi.mock('./useSessionBoardHostActionBindings', () => ({
    useSessionBoardHostActionBindings: () => undefined,
}));
// The code surface selects its platform module through a bundler-only require,
// and holds input the host observes only through an explicit flush.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: React.forwardRef(function MockCodeEditor(props: Readonly<{
        testID?: string;
        value: string;
    }>, ref: React.ForwardedRef<Readonly<{
        getValue: () => string;
        flushPendingChange: () => Promise<void>;
    }>>) {
        const testID = props.testID ?? 'code-editor';
        React.useImperativeHandle(ref, () => ({
            getValue: () => editorHarness.pending.get(testID) ?? props.value,
            flushPendingChange: async () => {
                await editorHarness.flushBarrier;
            },
        }), [props.value, testID]);
        return React.createElement('MockCodeEditor', props);
    }),
}));
vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: async () => {
        alertHarness.prompts += 1;
        return alertHarness.decision;
    },
}));

import {
    resolveSessionBoardHostVisibility,
    resolveSessionBoardItemPrimaryMountHost,
    type SessionBoardDetailsDestination,
} from './sessionBoardHostVisibility';
import { SessionBoardContinuityProvider, useMountedSessionBoardContinuity } from './SessionBoardContinuity';
import { SessionBoardControllerOwner, useMountedSessionBoardController } from './SessionBoardControllerProvider';
import { SessionBoardDetailsSurface } from './SessionBoardDetailsSurface';
import { SessionWidgetHost, type SessionWidgetHostProps } from './SessionWidgetHost';
import type { SessionBoardBinding } from './observeSessionBoard';

/** The mounted-owner binding shape: a ready snapshot plus its refresh handle. */
type MountedBinding = SessionBoardBinding & Readonly<{ refresh?: () => void }>;
import type { SessionBoardController } from './useSessionBoardController';

const ADDRESS: SessionAddress = { serverId: 'home-1', sessionId: 'session-1' };

const PLUGIN_RUNTIME = {
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'unavailable' as const,
    interactionEnabled: false,
    machineId: null,
    serverId: ADDRESS.serverId,
    platform: 'web' as const,
} as unknown as SessionPluginRuntimeState;

const HOSTED_HTML_RUNTIME = {
    serverIdentityId: 'identity-1',
    accountId: 'account-1',
    hostOrigin: 'https://example.invalid',
    admittedHostMethods: [],
    isApproved: () => true,
    approve: () => undefined,
    revoke: () => undefined,
    createRequestController: () => ({ dispose: () => undefined }),
    lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
} as unknown as CallerHostedHtmlRuntime;

const LAYOUT: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'item-1', width: 'medium' }] }],
} as SessionBoardLayoutV1;

function noteItem(title: string, body: string): SessionSurfaceItemV1 {
    return {
        v: 1,
        title,
        frame: 'card',
        height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1(body) },
    } as SessionSurfaceItemV1;
}

function hostedHtmlItem(title: string, html: string): SessionSurfaceItemV1 {
    return {
        v: 1,
        title,
        frame: 'full_bleed',
        height: { mode: 'fixed', size: 'tall' },
        source: {
            kind: 'hostedHtml',
            source: { kind: 'html', html },
            requestedCapabilities: { hostMethods: ['notify'] },
        },
    } as SessionSurfaceItemV1;
}

function snapshotWith(item: SessionSurfaceItemV1): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: { revision: 'rev-layout', outcome: { status: 'ready', value: LAYOUT } },
        items: new Map([['item-1', { revision: 'rev-item-1', outcome: { status: 'ready' as const, value: item } }]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

function mutationRichSnapshot(): SessionBoardSnapshot {
    const layout = {
        v: 1,
        tabs: [
            {
                id: 'overview',
                title: 'Overview',
                items: [
                    { itemId: 'item-1', width: 'medium' },
                    { itemId: 'item-2', width: 'medium' },
                ],
            },
            { id: 'research', title: 'Research', items: [] },
        ],
    } as SessionBoardLayoutV1;
    return projectSessionBoard({
        layout: { revision: 'rev-layout', outcome: { status: 'ready', value: layout } },
        items: new Map([
            ['item-1', { revision: 'rev-item-1', outcome: { status: 'ready' as const, value: noteItem('Plan', 'body') } }],
            ['item-2', { revision: 'rev-item-2', outcome: { status: 'ready' as const, value: hostedHtmlItem('Dashboard', '<main>base</main>') } }],
            ['orphan-1', { revision: 'rev-orphan-1', outcome: { status: 'ready' as const, value: noteItem('Recovered', 'body') } }],
        ]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

type RecordedCall =
    | Readonly<{ kind: 'upsert'; input: SessionBoardItemUpsertInput }>
    | Readonly<{ kind: 'remove'; input: SessionBoardItemRemoveInput }>;

function recordingActions(): Readonly<{ port: SessionBoardActionsPort; calls: RecordedCall[] }> {
    const calls: RecordedCall[] = [];
    const ok = (result: SessionBoardMutationResult['result']): SessionBoardActionOutcome<SessionBoardMutationResult> => ({
        status: 'ok',
        value: {
            v: 1,
            serverId: ADDRESS.serverId,
            sessionId: ADDRESS.sessionId,
            result,
            destination: null,
        } as SessionBoardMutationResult,
    });
    return {
        calls,
        port: {
            upsertItem: async (input) => {
                calls.push({ kind: 'upsert', input });
                return ok({
                    operation: 'upsert_item',
                    itemId: input.itemId,
                    outcome: 'updated',
                    itemRevision: 'rev-item-2',
                } as SessionBoardMutationResult['result']);
            },
            removeItem: async (input) => {
                calls.push({ kind: 'remove', input });
                return ok({
                    operation: 'remove_item',
                    itemId: input.itemId,
                    outcome: 'removed',
                    layoutRevision: 'rev-layout-2',
                } as SessionBoardMutationResult['result']);
            },
            updateLayout: async () => ok({
                operation: 'update_layout',
                layoutRevision: 'rev-layout-2',
            } as SessionBoardMutationResult['result']),
        },
    };
}

function BoardOwner(props: Readonly<{
    binding: MountedBinding;
    actions: SessionBoardActionsPort;
    activeHost: 'details' | 'focusedDetails';
    onController: (controller: SessionBoardController | null) => void;
}>): React.ReactElement {
    const continuity = useMountedSessionBoardContinuity();
    return (
        <SessionBoardControllerOwner
            address={ADDRESS}
            input={{
                sessionId: ADDRESS.sessionId,
                serverId: ADDRESS.serverId,
                binding: props.binding,
                actions: props.actions,
                confirmDestructive: async () => true,
                callerHostedHtmlAvailable: true,
                onManagePlugin: retainedPaneHarness.managePlugin,
                onPrepareEncryption: retainedPaneHarness.prepareEncryption,
                ...(continuity
                    ? { beforeReplaceNoteDraft: (replace: () => void | Promise<void>) => continuity.draftGuard.run(replace) }
                    : {}),
            }}
            binding={props.binding}
            actions={props.actions}
            pluginRuntime={PLUGIN_RUNTIME}
            callerHostedHtmlRuntime={HOSTED_HTML_RUNTIME}
        >
            <ControllerProbe onController={props.onController} />
            <SessionBoardDetailsSurface
                sessionId={ADDRESS.sessionId}
                serverId={ADDRESS.serverId}
                paneScopeId="pane-details"
                host="details"
                active={props.activeHost === 'details'}
                pluginRuntime={PLUGIN_RUNTIME}
                callerHostedHtmlRuntime={HOSTED_HTML_RUNTIME}
                onReadFullItem={retainedPaneHarness.readFullItem}
            />
            <SessionBoardDetailsSurface
                sessionId={ADDRESS.sessionId}
                serverId={ADDRESS.serverId}
                paneScopeId="pane-focused-details"
                host="focusedDetails"
                active={props.activeHost === 'focusedDetails'}
                pluginRuntime={PLUGIN_RUNTIME}
                callerHostedHtmlRuntime={HOSTED_HTML_RUNTIME}
                onReadFullItem={retainedPaneHarness.readFullItem}
            />
        </SessionBoardControllerOwner>
    );
}

function ControllerProbe(props: Readonly<{
    onController: (controller: SessionBoardController | null) => void;
}>): null {
    props.onController(useMountedSessionBoardController(ADDRESS)?.controller ?? null);
    return null;
}

function Harness(props: Readonly<{
    binding: MountedBinding;
    actions: SessionBoardActionsPort;
    activeHost: 'details' | 'focusedDetails';
    onController: (controller: SessionBoardController | null) => void;
}>): React.ReactElement {
    return (
        <SessionBoardContinuityProvider sessionId={ADDRESS.sessionId} serverId={ADDRESS.serverId}>
            <BoardOwner {...props} />
        </SessionBoardContinuityProvider>
    );
}

describe('retained Details Board tabs', () => {
    let controller: SessionBoardController | null = null;
    const onController = (next: SessionBoardController | null) => { controller = next; };

    beforeEach(() => {
        standardCleanup();
        controller = null;
        editorHarness.pending.clear();
        editorHarness.flushBarrier = null;
        alertHarness.decision = 'save';
        alertHarness.prompts = 0;
        retainedPaneHarness.companionItems = [{ kind: 'widget', widgetId: 'item-1' }];
        retainedPaneHarness.companionAvailable = false;
        retainedPaneHarness.companionShow.mockReset();
        retainedPaneHarness.companionRemoveItem.mockReset();
        retainedPaneHarness.managePlugin.mockReset();
        retainedPaneHarness.prepareEncryption.mockReset();
        retainedPaneHarness.readFullItem.mockReset();
    });

    async function mountBoard(item: SessionSurfaceItemV1, actions: SessionBoardActionsPort) {
        const binding: MountedBinding = {
            status: 'ready',
            snapshot: snapshotWith(item),
            refresh: () => undefined,
        };
        const screen = await renderScreen(
            <Harness
                binding={binding}
                actions={actions}
                activeHost="details"
                onController={onController}
            />,
        );
        return { screen, binding };
    }

    it('mounts one Board editor and one Add row for two retained Details tabs', async () => {
        const actions = recordingActions();
        const { screen } = await mountBoard(noteItem('Plan', 'body'), actions.port);

        await act(async () => { await controller?.run({ kind: 'add', intent: 'note' }); });

        expect(screen.findAllHostsByTestId('session-board-note-editor')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('session-board-pane-surface-add')).toHaveLength(1);
    });

    it('keeps every retained Board mutation port off the hidden pane while preserving its mounted content', async () => {
        const actions = recordingActions();
        retainedPaneHarness.companionAvailable = true;
        const binding: MountedBinding = {
            status: 'ready',
            snapshot: mutationRichSnapshot(),
            refresh: () => undefined,
        };
        const screen = await renderScreen(
            <Harness
                binding={binding}
                actions={actions.port}
                activeHost="details"
                onController={onController}
            />,
        );

        const itemHosts = screen.tree.root.findAllByType(SessionWidgetHost);
        const active = itemHosts.filter((node) => node.props.host === 'details');
        const retained = itemHosts.filter((node) => node.props.host === 'focusedDetails');
        expect(active).toHaveLength(3);
        expect(retained).toHaveLength(3);

        const activeById = new Map(active.map((node) => [node.props.item.itemId, node.props as SessionWidgetHostProps]));
        const retainedById = new Map(retained.map((node) => [node.props.item.itemId, node.props as SessionWidgetHostProps]));
        const activePlaced = activeById.get('item-1');
        const activeOther = activeById.get('item-2');
        const hiddenPlaced = retainedById.get('item-1');
        const hiddenOther = retainedById.get('item-2');
        const hiddenRecovered = retainedById.get('orphan-1');

        expect(activePlaced).toEqual(expect.objectContaining({
            onRemove: expect.any(Function),
            onUnpin: expect.any(Function),
            onEdit: expect.any(Function),
            onRename: expect.any(Function),
            onResize: expect.any(Function),
            onSetHeight: expect.any(Function),
            onMove: expect.any(Function),
            onMoveToView: expect.any(Function),
            onManagePlugin: expect.any(Function),
            onPrepareEncryption: expect.any(Function),
            onRemoveFromCompanion: expect.any(Function),
        }));
        expect(activeOther?.onAddToCompanion).toEqual(expect.any(Function));

        const mutatingProps = [
            'onRemove',
            'onUnpin',
            'onEdit',
            'onRename',
            'onResize',
            'onSetHeight',
            'onMove',
            'entityDrag',
            'onMoveToView',
            'onManagePlugin',
            'onPrepareEncryption',
            'onAddToCompanion',
            'onRemoveFromCompanion',
        ] as const;
        for (const hidden of [hiddenPlaced, hiddenOther, hiddenRecovered]) {
            for (const prop of mutatingProps) expect(hidden?.[prop]).toBeUndefined();
            // Read/open presentation remains mounted; only mutation ports retire.
            expect(hidden?.onReadFull).toEqual(expect.any(Function));
            expect(hidden?.pluginRuntime).toBe(PLUGIN_RUNTIME);
            expect(hidden?.callerHostedHtmlRuntime).toBe(HOSTED_HTML_RUNTIME);
        }

        // Only the active pane publishes the recovered-item Pin control.
        expect(screen.findAllHostsByTestId('session-board-pane-surface-recovered-pin-orphan-1')).toHaveLength(1);

        hiddenPlaced?.onRemove?.();
        hiddenPlaced?.onRemoveFromCompanion?.();
        hiddenPlaced?.onManagePlugin?.();
        hiddenPlaced?.onPrepareEncryption?.();
        expect(actions.calls).toEqual([]);
        expect(retainedPaneHarness.companionRemoveItem).not.toHaveBeenCalled();
        expect(retainedPaneHarness.managePlugin).not.toHaveBeenCalled();
        expect(retainedPaneHarness.prepareEncryption).not.toHaveBeenCalled();

        activePlaced?.onRemoveFromCompanion?.();
        expect(retainedPaneHarness.companionRemoveItem).toHaveBeenCalledWith({ kind: 'widget', widgetId: 'item-1' });
    });

    it('keeps a hidden Details tab from answering Save over the visible editor', async () => {
        const actions = recordingActions();
        const { screen } = await mountBoard(noteItem('Plan', 'body'), actions.port);

        await act(async () => { await controller?.run({ kind: 'add', intent: 'note' }); });
        editorHarness.pending.set('code-editor', 'Final answer');

        // A draft-replacing intent consults the ONE registered guard.
        await act(async () => { await controller?.run({ kind: 'add', intent: 'note' }); });

        expect(alertHarness.prompts).toBe(1);
        const upserts = actions.calls.filter((call) => call.kind === 'upsert');
        expect(upserts).toHaveLength(1);
        expect(JSON.stringify(upserts[0]?.input.item)).toContain('Final answer');
    });

    it('preserves the final character when the retained tab becomes the active one', async () => {
        const actions = recordingActions();
        const { screen, binding } = await mountBoard(noteItem('Plan', 'body'), actions.port);

        await act(async () => { await controller?.run({ kind: 'add', intent: 'note' }); });
        // The editor owns this value inside its debounce window. React state and
        // the shared continuity buffer have not observed it yet.
        editorHarness.pending.set('code-editor', 'Final answer');

        await screen.update(
            <Harness
                binding={binding}
                actions={actions.port}
                activeHost="focusedDetails"
                onController={onController}
            />,
        );

        const afterSwitch = screen.findAllByType('MockCodeEditor' as never);
        expect(afterSwitch).toHaveLength(1);
        expect(afterSwitch[0]?.props.value).toBe('Final answer');
    });

    it('hands an editor-held interactive view draft to the newly active tab and leaves one working guard', async () => {
        const actions = recordingActions();
        const { screen, binding } = await mountBoard(hostedHtmlItem('Dashboard', '<main>base</main>'), actions.port);

        await act(async () => { await controller?.run({ kind: 'item.edit', itemId: 'item-1' }); });
        editorHarness.pending.set('session-board-hosted-html-editor-source', '<main>final</main>');
        let releaseFlush: () => void = () => undefined;
        editorHarness.flushBarrier = new Promise<void>((resolve) => { releaseFlush = resolve; });

        await screen.update(
            <Harness
                binding={binding}
                actions={actions.port}
                activeHost="focusedDetails"
                onController={onController}
            />,
        );

        // The outgoing editor remains the sole mounted editor while a native
        // WebView-style flush round-trip is unresolved; the incoming host must
        // not initialize from stale continuity state.
        const duringFlush = screen.findAllHostsByTestId('session-board-hosted-html-editor-source');
        expect(duringFlush).toHaveLength(1);
        expect(duringFlush[0]?.props.value).toBe('<main>base</main>');
        await act(async () => {
            releaseFlush();
            await editorHarness.flushBarrier;
            await Promise.resolve();
        });
        editorHarness.flushBarrier = null;

        const afterSwitch = screen.findAllHostsByTestId('session-board-hosted-html-editor-source');
        expect(afterSwitch).toHaveLength(1);
        expect(afterSwitch[0]?.props.value).toBe('<main>final</main>');

        // The newly active editor is the sole draft/guard owner. A later
        // draft-replacing intent prompts once and saves exactly its current text.
        editorHarness.pending.set('session-board-hosted-html-editor-source', '<main>after handoff</main>');
        await act(async () => { await controller?.run({ kind: 'add', intent: 'note' }); });

        expect(alertHarness.prompts).toBe(1);
        const upserts = actions.calls.filter((call) => call.kind === 'upsert');
        expect(upserts).toHaveLength(1);
        expect(JSON.stringify(upserts[0]?.input.item)).toContain('<main>after handoff</main>');
    });

    it('offers Keep Editing / Save / Discard before removing the interactive view being edited', async () => {
        const actions = recordingActions();
        const { screen } = await mountBoard(hostedHtmlItem('Dashboard', '<main>base</main>'), actions.port);

        await act(async () => { await controller?.run({ kind: 'item.edit', itemId: 'item-1' }); });
        expect(screen.findAllHostsByTestId('session-board-hosted-html-editor')).toHaveLength(1);
        // Input the code surface holds but the host has not observed yet.
        editorHarness.pending.set('session-board-hosted-html-editor-source', '<main>final</main>');

        alertHarness.decision = 'keepEditing';
        await act(async () => { await controller?.run({ kind: 'item.remove', itemId: 'item-1' }); });

        expect(alertHarness.prompts).toBe(1);
        expect(actions.calls).toEqual([]);
        expect(screen.findAllHostsByTestId('session-board-hosted-html-editor')).toHaveLength(1);
    });

    it('saves the final unobserved keystroke before an applied removal retires the editor', async () => {
        const actions = recordingActions();
        const { screen } = await mountBoard(hostedHtmlItem('Dashboard', '<main>base</main>'), actions.port);

        await act(async () => { await controller?.run({ kind: 'item.edit', itemId: 'item-1' }); });
        editorHarness.pending.set('session-board-hosted-html-editor-source', '<main>final</main>');

        alertHarness.decision = 'save';
        await act(async () => { await controller?.run({ kind: 'item.remove', itemId: 'item-1' }); });

        expect(actions.calls.map((call) => call.kind)).toEqual(['upsert', 'remove']);
        const upsert = actions.calls[0];
        expect(upsert?.kind === 'upsert' && JSON.stringify(upsert.input.item)).toContain('<main>final</main>');
        expect(screen.findAllHostsByTestId('session-board-hosted-html-editor')).toHaveLength(0);
    });
});

/**
 * The generic Board destination and an item's expanded destination are different
 * tabs on purpose, so a split Details workspace can present both at once. Both are
 * the `details` host and both draw the item at full density: comparing host kinds
 * alone gave one executable item two live frames.
 */
function DestinationOwner(props: Readonly<{
    binding: MountedBinding;
    actions: SessionBoardActionsPort;
    expandedVisible: boolean;
}>): React.ReactElement {
    const visibility = resolveSessionBoardHostVisibility({
        foreground: true,
        panes: {
            detailsOpen: true,
            detailsShowsBoard: true,
            detailsExpandedItemIds: props.expandedVisible ? ['item-2'] : [],
            detailsFocusModeActive: false,
            rightOpen: false,
            rightActiveTabId: null,
        },
        companionPlacement: { kind: 'hidden' },
        mobileSurface: null,
    });
    const resolvePrimaryHost = (itemId: string, destination?: SessionBoardDetailsDestination) => (
        resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: false,
            itemId,
            ...(destination ? { detailsDestination: destination } : {}),
        })
    );
    return (
        <SessionBoardControllerOwner
            address={ADDRESS}
            input={{
                sessionId: ADDRESS.sessionId,
                serverId: ADDRESS.serverId,
                binding: props.binding,
                actions: props.actions,
                confirmDestructive: async () => true,
                callerHostedHtmlAvailable: true,
            }}
            binding={props.binding}
            actions={props.actions}
            pluginRuntime={PLUGIN_RUNTIME}
            callerHostedHtmlRuntime={HOSTED_HTML_RUNTIME}
        >
            <SessionBoardDetailsSurface
                sessionId={ADDRESS.sessionId}
                serverId={ADDRESS.serverId}
                paneScopeId="pane-details"
                host="details"
                active
                resolvePrimaryHost={resolvePrimaryHost}
                pluginRuntime={PLUGIN_RUNTIME}
                callerHostedHtmlRuntime={HOSTED_HTML_RUNTIME}
            />
            {props.expandedVisible ? (
                <SessionBoardDetailsSurface
                    sessionId={ADDRESS.sessionId}
                    serverId={ADDRESS.serverId}
                    paneScopeId="pane-details"
                    host="details"
                    active
                    focusedItemId="item-2"
                    resolvePrimaryHost={resolvePrimaryHost}
                    pluginRuntime={PLUGIN_RUNTIME}
                    callerHostedHtmlRuntime={HOSTED_HTML_RUNTIME}
                />
            ) : null}
        </SessionBoardControllerOwner>
    );
}

describe('two visible Details Board destinations', () => {
    beforeEach(() => {
        standardCleanup();
        retainedPaneHarness.companionItems = [{ kind: 'widget', widgetId: 'item-1' }];
        retainedPaneHarness.companionAvailable = false;
    });

    async function mountDestinations(expandedVisible: boolean) {
        const binding: MountedBinding = {
            status: 'ready',
            snapshot: mutationRichSnapshot(),
            refresh: () => undefined,
        };
        const screen = await renderScreen(
            <SessionBoardContinuityProvider sessionId={ADDRESS.sessionId} serverId={ADDRESS.serverId}>
                <DestinationOwner
                    binding={binding}
                    actions={recordingActions().port}
                    expandedVisible={expandedVisible}
                />
            </SessionBoardContinuityProvider>,
        );
        return screen.tree.root.findAllByType(SessionWidgetHost)
            .filter((node) => (node.props as SessionWidgetHostProps).item.itemId === 'item-2')
            .map((node) => node.props as SessionWidgetHostProps);
    }

    it('runs the executable item in exactly one of the two presented destinations', async () => {
        const copies = await mountDestinations(true);

        expect(copies).toHaveLength(2);
        const executable = copies.filter((copy) => copy.primaryHost === copy.host);
        expect(executable).toHaveLength(1);
        // The destination a person opened FOR the item is the one that runs it.
        expect(copies.filter((copy) => copy.expanded === true).map((copy) => copy.primaryHost))
            .toEqual(['details']);
    });

    it('hands the mount back to the Board when the expanded destination is not presented', async () => {
        const copies = await mountDestinations(false);

        expect(copies).toHaveLength(1);
        expect(copies[0]?.primaryHost).toBe('details');
    });
});

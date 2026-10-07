import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    createSessionSurfaceNoteDocumentV1,
    SessionBoardMutationV1Schema,
    type SessionBoardLayoutV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { renderScreen } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import {
    projectSessionBoard,
    type SessionBoardActionsPort,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';
import { SessionBoardSurface } from './SessionBoardSurface';
import { useSessionBoardController } from './useSessionBoardController';
import { realBoardActions } from './sessionBoardActionsTestkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit');
    return createReactNativeWebMock();
});

/**
 * The shared Board surface, rendered.
 *
 * These are the failures a person meets rather than a type checker: an Add button
 * that only exists while the Board is empty, a selected view that shows nothing and
 * says nothing, an item stranded off every view with no way back, and controls for
 * sources this build cannot actually create.
 */

function note(title: string): SessionSurfaceItemV1 {
    return {
        v: 1,
        title,
        frame: 'card',
        height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1(`${title} body`) },
    } as SessionSurfaceItemV1;
}

const ADDRESS = { serverId: 'home-1', sessionId: 'session-1' };
const REVISION = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const NEXT_REVISION = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
const OK_ACTIONS = realBoardActions(async () => new Response(null, { status: 404 }), undefined, ADDRESS);

function snapshot(input: Readonly<{
    layout?: SessionBoardLayoutV1 | null;
    items?: ReadonlyArray<Readonly<{ itemId: string; item: SessionSurfaceItemV1 }>>;
    canEdit?: boolean;
    incomplete?: boolean;
}>): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: input.layout
            ? { revision: REVISION, outcome: { status: 'ready', value: input.layout } }
            : undefined,
        items: new Map((input.items ?? []).map(({ itemId, item }) => [itemId, {
            revision: REVISION,
            outcome: { status: 'ready' as const, value: item },
        }] as const)),
        capabilities: { readTranscript: true, editSessionRecords: input.canEdit ?? true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: input.incomplete ?? false,
    });
}

function Harness(props: Readonly<{
    snapshot: SessionBoardSnapshot;
    serverId?: string;
    actions?: SessionBoardActionsPort | null;
    companionItemIds?: ReadonlySet<string>;
    onAddToCompanion?: (itemId: string) => void;
    onRemoveFromCompanion?: (itemId: string) => void;
    onPrepareEncryption?: () => void;
    refresh?: () => void | Promise<void>;
    host?: 'details' | 'mobileCockpit';
    onAskAgent?: () => void;
}>): React.ReactElement {
    const controller = useSessionBoardController({
        sessionId: 'session-1',
        serverId: props.serverId ?? 'home-1',
        binding: { status: 'ready', snapshot: props.snapshot, refresh: props.refresh ?? (() => {}) },
        actions: props.actions === undefined ? OK_ACTIONS : props.actions,
        ...(props.onAskAgent ? { onAskAgent: props.onAskAgent } : {}),
        ...(props.onPrepareEncryption ? { onPrepareEncryption: props.onPrepareEncryption } : {}),
    });
    return (
        <SessionBoardSurface
            sessionId="session-1"
            serverId={props.serverId ?? 'home-1'}
            controller={controller}
            host={props.host ?? 'details'}
            resolvePrimaryHost={() => props.host ?? 'details'}
            density="full"
            layout={props.host === 'mobileCockpit' ? 'single' : 'grid'}
            {...(props.companionItemIds ? { companionItemIds: props.companionItemIds } : {})}
            {...(props.onAddToCompanion ? { onAddToCompanion: props.onAddToCompanion } : {})}
            {...(props.onRemoveFromCompanion ? { onRemoveFromCompanion: props.onRemoveFromCompanion } : {})}
        />
    );
}

/** The one pane header a real host draws, reading what the Board published into its slot. */
function PublishedHeader() {
    const content = usePublishedPaneHeaderContent('board');
    const line = content?.line?.segments.map((segment) => (typeof segment === 'string' ? segment : segment.text)).join(' · ') ?? '';
    return React.createElement('View', { testID: 'pane-header' }, React.createElement('Text', { testID: 'pane-header-line' }, line), content?.action ?? null);
}

/** The compact sidebar (read-only monitor) or the phone Board, inside a header-owning pane. */
function PaneHarness(props: Readonly<{
    snapshot: SessionBoardSnapshot;
    host: 'sidebar' | 'mobileCockpit';
    onOpenBoardDetails?: () => void;
    onOpenItemHere?: (itemId: string) => void;
    onAskAgent?: () => void;
    companionItemIds?: ReadonlySet<string>;
}>): React.ReactElement {
    const controller = useSessionBoardController({
        sessionId: 'session-1',
        serverId: 'home-1',
        binding: { status: 'ready', snapshot: props.snapshot, refresh: () => {} },
        actions: OK_ACTIONS,
        ...(props.onAskAgent ? { onAskAgent: props.onAskAgent } : {}),
    });
    return (
        <PaneHeaderSlotProvider>
            <PublishedHeader />
            <PaneHeaderSlotScope slotKey="board">
                <SessionBoardSurface
                    sessionId="session-1"
                    controller={controller}
                    host={props.host}
                    resolvePrimaryHost={() => props.host}
                    density={props.host === 'sidebar' ? 'compact' : 'full'}
                    layout="single"
                    {...(props.host === 'sidebar' ? { navigationOnly: true } : {})}
                    {...(props.onOpenBoardDetails ? { onOpenBoardDetails: props.onOpenBoardDetails } : {})}
                    {...(props.onOpenItemHere ? { onOpenItemHere: props.onOpenItemHere } : {})}
                    {...(props.companionItemIds ? { companionItemIds: props.companionItemIds } : {})}
                />
            </PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
    );
}

/**
 * The operation set one card publishes. The overflow is a person's only route to
 * these, so its contents are the card's contract rather than an internal detail.
 */
function publishedActionIds(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    overflowTriggerTestID: string,
): readonly string[] {
    const owner = screen.tree.root.findAll(
        (node) => Array.isArray((node.props as { actions?: unknown }).actions)
            && (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID === overflowTriggerTestID,
        { deep: true },
    );
    const actions = (owner.at(-1)?.props as { actions?: ReadonlyArray<{ id: string }> } | undefined)?.actions ?? [];
    return actions.map((action) => action.id);
}

/** Opens the Board's Add popover and returns what it offers (its sections and ask entry). */
async function openAddPopover(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    triggerTestID: string,
): Promise<Readonly<{
    sections: ReadonlyArray<Readonly<{ id: string; entries: ReadonlyArray<Readonly<{ id: string; onPick: () => void }>> }>>;
    ask?: Readonly<{ onPick: () => void }>;
}>> {
    await act(async () => { screen.pressByTestId(triggerTestID); });
    const popover = screen.tree.root.findAll(
        (node) => Array.isArray((node.props as { sections?: unknown }).sections)
            && typeof (node.props as { searchPlaceholder?: unknown }).searchPlaceholder === 'string',
        { deep: true },
    ).at(-1);
    if (!popover) throw new Error('Expected the Add popover to be open');
    return popover.props as never;
}

const POPULATED: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }] }],
} as SessionBoardLayoutV1;

const MOVABLE: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [{
        id: 'overview',
        title: 'Overview',
        items: [
            { itemId: 'note-1', width: 'medium' },
            { itemId: 'note-2', width: 'medium' },
        ],
    }],
} as SessionBoardLayoutV1;

function mutableLayout(layout: SessionBoardLayoutV1) {
    return {
        v: 1 as const,
        tabs: layout.tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            items: tab.items.map((item) => ({ ...item })),
        })),
    };
}

describe('SessionBoardSurface', () => {
    it('does not claim a last loaded version before any Board item has loaded', async () => {
        const initial = snapshot({});
        const screen = await renderScreen(
            <Harness snapshot={{ ...initial, freshness: 'stale', loading: 'refreshing' }} />,
        );
        expect(screen.findByTestId('session-board-freshness')).toBeNull();
    });

    it('keeps retained widgets at full strength under the shared freshness line when stale', async () => {
        const populated = snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] });
        const screen = await renderScreen(<Harness snapshot={{ ...populated, freshness: 'stale' }} />);
        expect(screen.findByTestId('session-board-freshness-text')?.props.children).toBe(t('sessionBoard.board.stale'));
        expect(screen.findHostByTestId('session-board-item-note-1')).not.toBeNull();
    });

    it('explains reconnection when offline before any Board content has loaded', async () => {
        const initial = snapshot({});
        const screen = await renderScreen(
            <Harness snapshot={{ ...initial, reachability: 'offline', freshness: 'stale' }} />,
        );
        // Nothing retained: a state card that names the cause, never a stale line over an empty body.
        expect(screen.findByTestId('session-board-freshness')).toBeNull();
        expect(screen.findHostByTestId('session-board-empty')).toBeNull();
        expect(screen.findHostByTestId('session-board-offline')).not.toBeNull();
    });

    it('keeps an ambiguous mutation visible and blocked until refresh enables a deliberate retry', async () => {
        let attempts = 0;
        const actions = realBoardActions(async (_path, init) => {
            if (init?.method !== 'PUT') return Response.json({ record: {
                id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                content: { t: 'plain', v: mutableLayout(POPULATED) }, revision: REVISION,
                createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
            } });
            const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
            expect(mutation.operation).toBe('update_layout');
            attempts += 1;
            // The server may have committed; losing only the acknowledgement
            // exercises the adapter's canonical outcome-unknown classification.
            return attempts === 1 ? new Response('acknowledgement lost') : Response.json({
                operation: 'update_layout', outcome: 'updated', layoutRevision: NEXT_REVISION,
            });
        }, undefined, ADDRESS);
        const refresh = vi.fn();
        const initial = snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] });
        const screen = await renderScreen(
            <Harness snapshot={initial} actions={actions} refresh={refresh} />,
        );
        const menu = screen.tree.root.findAll(
            (node) => (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID
                === 'session-board-item-note-1-actions',
            { deep: true },
        ).at(-1)?.props as { actions?: ReadonlyArray<{ id: string; onPress: () => void }> } | undefined;

        await act(async () => {
            await menu?.actions?.find((action) => action.id === 'resize-full')?.onPress();
        });
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-board-mutation-recovery')).not.toBeNull();
        expect(screen.findByTestId('session-board-mutation-recovery-retry')).toBeNull();

        // A completed repository refresh with unchanged canonical state cannot
        // prove whether the first request ran. It may expose retry, but must not
        // replay the mutation itself.
        await screen.update(
            <Harness
                snapshot={{ ...initial, freshness: 'stale', loading: 'refreshing' }}
                actions={actions}
                refresh={refresh}
            />,
        );
        await screen.update(
            <Harness
                snapshot={snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] })}
                actions={actions}
                refresh={refresh}
            />,
        );
        expect(attempts).toBe(1);
        const retry = screen.findByTestId('session-board-mutation-recovery-retry');
        expect(retry).not.toBeNull();

        await act(async () => { await retry?.props.onPress?.(); });
        expect(attempts).toBe(2);
        expect(screen.findByTestId('session-board-mutation-recovery')).toBeNull();
    });

    it.each(['details', 'mobileCockpit'] as const)(
        'moves focus to the mounted nearest Board view after the selected view is removed in the %s layout',
        async (host) => {
            const initial = snapshot({
                layout: {
                    v: 1,
                    tabs: [
                        { id: 'planning', title: 'Planning', items: [] },
                        { id: 'research', title: 'Research', items: [] },
                        { id: 'decisions', title: 'Decisions', items: [] },
                    ],
                } as SessionBoardLayoutV1,
            });
            const afterRemoval = snapshot({
                layout: {
                    v: 1,
                    tabs: [
                        { id: 'planning', title: 'Planning', items: [] },
                        { id: 'decisions', title: 'Decisions', items: [] },
                    ],
                } as SessionBoardLayoutV1,
            });
            const focusByTestId = new Map<string, ReturnType<typeof vi.fn>>();
            const screen = await renderScreen(<Harness host={host} snapshot={initial} />, {
                createNodeMock: (element) => {
                    const testID = (element.props as { testID?: string }).testID;
                    if (typeof testID !== 'string' || !testID.startsWith('session-board-views-view-')) return {};
                    let focus = focusByTestId.get(testID);
                    if (!focus) {
                        focus = vi.fn();
                        focusByTestId.set(testID, focus);
                    }
                    return { focus };
                },
            });

            await act(async () => {
                screen.findByTestId('session-board-views-view-research')?.props.onPress?.();
            });
            screen.findByTestId('session-board-views-view-research')?.props.onFocus?.();
            await screen.update(<Harness host={host} snapshot={afterRemoval} />);

            expect(focusByTestId.get('session-board-views-view-decisions')).toHaveBeenCalledOnce();
            expect(screen.findByTestId('session-board-views-view-decisions')?.props.accessibilityState).toEqual({
                selected: true,
            });
            expect(screen.findHostByTestId('session-board-scroll')?.props.accessibilityLabelledBy).toBe(
                screen.findByTestId('session-board-views-view-decisions')?.props.nativeID,
            );
        },
    );

    it('keeps placed and recovered items reachable in one filtered mobile Board', async () => {
        const screen = await renderScreen(
            <Harness
                host="mobileCockpit"
                snapshot={snapshot({
                    layout: POPULATED,
                    items: [
                        { itemId: 'note-1', item: note('Release plan') },
                        { itemId: 'recovered-1', item: note('Meeting notes') },
                    ],
                })}
            />,
        );

        expect(screen.getTextContent()).toContain('Release plan');
        expect(screen.getTextContent()).toContain('Meeting notes');
        await act(async () => {
            screen.findByTestId('session-board-search:input')?.props.onChangeText?.('meeting');
        });
        expect(screen.getTextContent()).not.toContain('Release plan');
        expect(screen.getTextContent()).toContain('Meeting notes');
        expect(screen.root.findAllByProps({ testID: 'session-board-scroll' })).toHaveLength(1);
    });

    it('offers the mounted encryption recovery action when the shared layout is locked', async () => {
        const onPrepareEncryption = vi.fn();
        const locked = projectSessionBoard({
            layout: { revision: 'rev-layout', outcome: { status: 'locked' } },
            items: new Map(),
            capabilities: { readTranscript: true, editSessionRecords: true },
            freshness: 'fresh',
            reachability: 'reachable',
            loading: 'idle',
            incomplete: false,
        });
        const screen = await renderScreen(
            <Harness snapshot={locked} onPrepareEncryption={onPrepareEncryption} />,
        );

        const action = screen.findByTestId('session-board-state-action');
        expect(action?.props.accessibilityLabel).toBeTruthy();
        // The press is a real interaction: the recovery control renders its own
        // pressed feedback, so committing it outside `act` left that state update
        // unobserved and reported as a warning rather than being asserted on.
        await act(async () => { await action?.props.onPress?.(); });
        expect(onPrepareEncryption).toHaveBeenCalledTimes(1);
    });

    it('routes an existing Board widget through the viewer-local Companion action', async () => {
        const add = vi.fn();
        const remove = vi.fn();
        const populated = snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] });

        const addScreen = await renderScreen(
            <Harness snapshot={populated} onAddToCompanion={add} onRemoveFromCompanion={remove} />,
        );
        const addActions = (addScreen.tree.root.findAll(
            (node) => (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID === 'session-board-item-note-1-actions',
            { deep: true },
        ).at(-1)?.props as { actions?: ReadonlyArray<{ id: string; onPress: () => void }> } | undefined)?.actions ?? [];
        addActions.find((action) => action.id === 'add-to-companion')?.onPress();
        expect(add).toHaveBeenCalledWith('note-1');

        const removeScreen = await renderScreen(
            <Harness
                snapshot={populated}
                companionItemIds={new Set(['note-1'])}
                onAddToCompanion={add}
                onRemoveFromCompanion={remove}
            />,
        );
        const removeActions = (removeScreen.tree.root.findAll(
            (node) => (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID === 'session-board-item-note-1-actions',
            { deep: true },
        ).at(-1)?.props as { actions?: ReadonlyArray<{ id: string; onPress: () => void }> } | undefined)?.actions ?? [];
        removeActions.find((action) => action.id === 'remove-from-companion')?.onPress();
        expect(remove).toHaveBeenCalledWith('note-1');
    });

    it('keeps one Add chooser reachable after the Board has content', async () => {
        const onAskAgent = vi.fn();
        const screen = await renderScreen(
            <Harness snapshot={snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] })} onAskAgent={onAskAgent} />,
        );

        expect(screen.findByTestId('session-board-add-trigger')).not.toBeNull();
        expect(screen.findHostByTestId('session-board-add-note')).toBeNull();
        const popover = await openAddPopover(screen, 'session-board-add-trigger');
        // Both built-in producers are available; no installed or hosted source exists here.
        expect(popover.sections.flatMap((section) => section.entries.map((entry) => entry.id))).toEqual(['walkthrough', 'note']);
        expect(popover.ask).toBeDefined();
        await act(async () => { popover.ask?.onPick(); });
        expect(onAskAgent).toHaveBeenCalledOnce();
        expect(screen.findHostByTestId('session-board-empty')).toBeNull();
    });

    it('starts direct manipulation only from a visible move handle', async () => {
        const serverUrl = 'https://board-drag.example.test';
        const serverId = 'srv_board_drag';
        await upsertServerProfile({ serverUrl, name: 'Board drag Home' });
        await setServerProfileIdentityForUrl(serverUrl, serverId);
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'board-editor' })).toString('base64url')}.signature`,
        })).toBe(true);
        const screen = await renderScreen(
            <Harness snapshot={snapshot({
                layout: MOVABLE,
                items: [
                    { itemId: 'note-1', item: note('Plan') },
                    { itemId: 'note-2', item: note('Review') },
                ],
            })} serverId={serverId} />,
        );
        try {
            await vi.waitFor(() => { expect(screen.findHostByTestId('session-board-item-note-1-move-handle')).not.toBeNull(); });
            const firstHandle = screen.findHostByTestId('session-board-item-note-1-move-handle');
            const secondHandle = screen.findHostByTestId('session-board-item-note-2-move-handle');
            expect(firstHandle).not.toBeNull();
            expect(secondHandle).not.toBeNull();
            expect(firstHandle?.props.accessibilityLabel).toBe(t('entityDragDrop.organize.grip', { item: 'Plan' }));
            expect(secondHandle?.props.accessibilityLabel).toBe(t('entityDragDrop.organize.grip', { item: 'Review' }));
            expect(firstHandle?.props.accessibilityHint).toBe(t('entityDragDrop.keyboard.hintsA11y'));
            expect(firstHandle?.props['aria-haspopup']).toBe('menu');
            expect(screen.findHostByTestId('session-board-item-note-1-body')?.props.gesture).toBeUndefined();
            await screen.pressByTestIdAsync('session-board-item-note-1-move-handle');
            // The canonical DropdownMenu opens on its scheduled interaction frame.
            await vi.waitFor(() => {
                expect(screen.findHostByTestId('session-board-item-note-1-move-handle')?.props.accessibilityState.expanded).toBe(true);
            });
        } finally { await screen.unmount(); }
    });

    it('offers the available built-in sources on an empty Board without advertising unavailable sources', async () => {
        const screen = await renderScreen(<Harness snapshot={snapshot({})} />);

        // The empty-state shortcut still creates a note; the chooser offers both producers.
        expect(screen.findByTestId('session-board-empty-action')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('sessionBoard.empty.editor.addNote'));
        const popover = await openAddPopover(screen, 'session-board-add-trigger');
        expect(popover.sections.flatMap((section) => section.entries.map((entry) => entry.id))).toEqual(['walkthrough', 'note']);
        expect(screen.getTextContent()).not.toContain(t('sessionBoard.add.interactiveView'));
    });

    it('offers no editing chrome at all to a viewer who cannot edit', async () => {
        const screen = await renderScreen(
            <Harness snapshot={snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }], canEdit: false })} />,
        );

        expect(screen.findByTestId('session-board-add-trigger')).toBeNull();
        // Not one editing control, and no menu to hide them in either.
        expect(screen.findHostByTestId('session-board-item-note-1-actions')).toBeNull();
        expect(screen.findHostByTestId('session-board-item-note-1-move-handle')).toBeNull();
        // The content itself stays fully readable.
        expect(screen.getTextContent()).toContain('Plan');
    });

    it('offers a view move only toward a neighbour that can anchor it', async () => {
        // The layout Action silently returns when there is nothing to anchor
        // against, so an "earlier" entry on the first view is a control the
        // person can press with no observable result.
        const screen = await renderScreen(
            <Harness
                snapshot={snapshot({
                    layout: {
                        v: 1,
                        tabs: [
                            { id: 'overview', title: 'Overview', items: [] },
                            { id: 'research', title: 'Research', items: [] },
                        ],
                    } as SessionBoardLayoutV1,
                    items: [],
                })}
            />,
        );

        const owner = screen.tree.root.findAll(
            (node) => Array.isArray((node.props as { actions?: unknown }).actions)
                && (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID === 'session-board-view-actions',
            { deep: true },
        ).at(-1);
        const ids = ((owner?.props as { actions: { id: string }[] } | undefined)?.actions ?? [])
            .map((action) => action.id);

        expect(ids).toContain('view-move-after');
        expect(ids).not.toContain('view-move-before');
    });

    it('explains a selected view that has no placements', async () => {
        const screen = await renderScreen(
            <Harness
                snapshot={snapshot({
                    layout: {
                        v: 1,
                        tabs: [
                            { id: 'overview', title: 'Overview', items: [] },
                            { id: 'research', title: 'Research', items: [{ itemId: 'note-1', width: 'medium' }] },
                        ],
                    } as SessionBoardLayoutV1,
                    items: [{ itemId: 'note-1', item: note('Plan') }],
                })}
            />,
        );

        expect(screen.findHostByTestId('session-board-empty-view')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Nothing in this view');
    });

    it('labels the active tabpanel with the selected Board view', async () => {
        const screen = await renderScreen(
            <Harness
                snapshot={snapshot({
                    layout: {
                        v: 1,
                        tabs: [
                            { id: 'overview', title: 'Overview', items: [] },
                            { id: 'research notes', title: 'Research', items: [] },
                        ],
                    } as SessionBoardLayoutV1,
                    items: [],
                })}
            />,
        );

        const selectedTab = screen.findByTestId('session-board-views-view-overview');
        const panel = screen.findHostByTestId('session-board-scroll');
        // `tabpanel` is an ARIA role, carried by `role`; React Native's
        // `accessibilityRole` union has no such member.
        expect(panel?.props.role).toBe('tabpanel');
        expect(panel?.props.nativeID).toBeTruthy();
        expect(panel?.props['aria-labelledby']).toBe(selectedTab?.props.nativeID);
        expect(panel?.props.accessibilityLabelledBy).toBe(selectedTab?.props.nativeID);
    });

    it('surfaces an item the shared layout places nowhere, with a way back onto the Board', async () => {
        const screen = await renderScreen(
            <Harness
                snapshot={snapshot({
                    layout: POPULATED,
                    items: [
                        { itemId: 'note-1', item: note('Plan') },
                        { itemId: 'orphan-1', item: note('Stranded') },
                    ],
                })}
            />,
        );

        expect(screen.findHostByTestId('session-board-recovered')).not.toBeNull();
        expect(screen.findByTestId('session-board-recovered-pin-orphan-1')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Stranded');
    });

    // Resize, reorder, Move to view and Remove from this view all address a
    // placement. A recovered item has none, so every one of them would be
    // answered `session_board_item_not_found` by the layout owner.
    it('publishes no placement-scoped operations on a recovered item', async () => {
        const screen = await renderScreen(
            <Harness
                snapshot={snapshot({
                    layout: {
                        v: 1,
                        tabs: [
                            { id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }] },
                            { id: 'research', title: 'Research', items: [] },
                        ],
                    } as SessionBoardLayoutV1,
                    items: [
                        { itemId: 'note-1', item: note('Plan') },
                        { itemId: 'orphan-1', item: note('Stranded') },
                    ],
                })}
            />,
        );

        const placedIds = publishedActionIds(screen, 'session-board-item-note-1-actions');
        const recoveredIds = publishedActionIds(screen, 'session-board-item-orphan-1-actions');

        // The placed card is the control: it keeps the full geometry/movement set.
        expect(placedIds).toContain('resize-medium');
        expect(placedIds).toContain('move-view-research');

        expect(recoveredIds.filter((id) => id.startsWith('resize-'))).toEqual([]);
        expect(recoveredIds.filter((id) => id.startsWith('move-'))).toEqual([]);
        expect(recoveredIds).not.toContain('unpin');
        // Pin back onto the Board and delete the shared record both still work.
        expect(screen.findByTestId('session-board-recovered-pin-orphan-1')).not.toBeNull();
        expect(recoveredIds).toContain('remove');
    });

    it('renders one item full-content on its expanded route instead of the grid', async () => {
        function FocusedHarness(): React.ReactElement {
            const controller = useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: {
                    status: 'ready',
                    snapshot: snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] }),
                },
                actions: OK_ACTIONS,
            });
            return (
                <SessionBoardSurface
                    sessionId="session-1"
                    controller={controller}
                    host="details"
                    resolvePrimaryHost={() => 'details'}
                    density="full"
                    layout="grid"
                    focusedItemId="note-1"
                    onLeaveFocusedItem={() => undefined}
                />
            );
        }

        const screen = await renderScreen(<FocusedHarness />);
        expect(screen.findHostByTestId('session-board-focused')).not.toBeNull();
        expect(screen.findByTestId('session-board-focused-back')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Plan');
    });

    it('keeps an exact removed item route in its focused shell instead of falling back to the Board', async () => {
        function RemovedFocusedHarness(): React.ReactElement {
            const controller = useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: { status: 'ready', snapshot: snapshot({ layout: POPULATED, items: [] }) },
                actions: OK_ACTIONS,
            });
            return (
                <SessionBoardSurface
                    sessionId="session-1"
                    controller={controller}
                    host="details"
                    resolvePrimaryHost={() => 'details'}
                    density="full"
                    layout="grid"
                    focusedItemId="removed-note"
                    onLeaveFocusedItem={() => undefined}
                />
            );
        }

        const screen = await renderScreen(<RemovedFocusedHarness />);
        expect(screen.findHostByTestId('session-board-focused')).not.toBeNull();
        expect(screen.findByTestId('session-board-focused-back')).not.toBeNull();
        expect(screen.findHostByTestId('session-board-item-removed-note-state')).not.toBeNull();
        expect(screen.findHostByTestId('session-board-scroll')).toBeNull();
    });

    it('keeps an unresolved exact item route loading while the Board inventory is incomplete', async () => {
        function LoadingFocusedHarness(): React.ReactElement {
            const controller = useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: {
                    status: 'ready',
                    snapshot: snapshot({ layout: POPULATED, items: [], incomplete: true }),
                },
                actions: OK_ACTIONS,
            });
            return (
                <SessionBoardSurface
                    sessionId="session-1"
                    controller={controller}
                    host="details"
                    resolvePrimaryHost={() => 'details'}
                    density="full"
                    layout="grid"
                    focusedItemId="pending-note"
                    onLeaveFocusedItem={() => undefined}
                />
            );
        }

        const screen = await renderScreen(<LoadingFocusedHarness />);
        expect(screen.findHostByTestId('session-board-focused')).not.toBeNull();
        expect(screen.findHostByTestId('session-board-item-pending-note-state-loading-spinner')).not.toBeNull();
        expect(screen.findHostByTestId('session-board-scroll')).toBeNull();
    });

    it('keeps the note editor visible inside the expanded Details composition', async () => {
        function FocusedEditorHarness(): React.ReactElement {
            const controller = useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: {
                    status: 'ready',
                    snapshot: snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] }),
                },
                actions: OK_ACTIONS,
            });
            return (
                <SessionBoardSurface
                    sessionId="session-1"
                    controller={controller}
                    host="details"
                    resolvePrimaryHost={() => 'details'}
                    density="full"
                    layout="grid"
                    focusedItemId="note-1"
                    editor={<React.Fragment><React.Fragment key="editor" /></React.Fragment>}
                />
            );
        }

        const screen = await renderScreen(<FocusedEditorHarness />);
        expect(screen.findHostByTestId('session-board-focused-editor')).not.toBeNull();
    });

    it('draws no write affordance while no Board Action producer is bound', async () => {
        const screen = await renderScreen(
            <Harness
                snapshot={snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] })}
                actions={null}
            />,
        );

        expect(screen.findByTestId('session-board-add-trigger')).toBeNull();
        expect(screen.findHostByTestId('session-board-item-note-1-actions')).toBeNull();
    });

    it('tells the sidebar pane header who sees the Board and how much is on it, with Open board as its one action', async () => {
        const openBoard = vi.fn();
        const screen = await renderScreen(
            <PaneHarness
                host="sidebar"
                snapshot={snapshot({ layout: MOVABLE, items: [
                    { itemId: 'note-1', item: note('Plan') },
                    { itemId: 'note-2', item: note('Risks') },
                ] })}
                onOpenBoardDetails={openBoard}
            />,
        );

        expect(screen.findByTestId('pane-header-line')?.props.children).toBe(
            `${t('sessionBoard.sidebar.sharedWithEveryone')} · ${t('sessionBoard.sidebar.widgetCount', { count: 2 })}`,
        );
        // The action moved into the header: the body no longer draws its own Open row.
        expect(screen.findHostByTestId('session-board-open-details')).toBeNull();
        await screen.pressByTestIdAsync('session-board-header-open-board');
        expect(openBoard).toHaveBeenCalledOnce();
    });

    it('opens a tapped sidebar card on the Details board and keeps Companion membership out of its header', async () => {
        const openItem = vi.fn();
        const screen = await renderScreen(
            <PaneHarness
                host="sidebar"
                snapshot={snapshot({ layout: MOVABLE, items: [
                    { itemId: 'note-1', item: note('Plan') },
                    { itemId: 'note-2', item: note('Risks') },
                ] })}
                onOpenItemHere={openItem}
                companionItemIds={new Set(['note-1'])}
            />,
        );

        expect(screen.findHostByTestId('session-board-item-note-1-companion-mark')).toBeNull();
        expect(screen.findHostByTestId('session-board-item-note-2-companion-mark')).toBeNull();
        expect(screen.findHostByTestId('session-board-item-note-1-title')).not.toBeNull();
        await screen.pressByTestIdAsync('session-board-item-note-2-open');
        expect(openItem).toHaveBeenCalledWith('note-2');
    });

    it('offers Ask the agent on an empty Board, even in the read-only sidebar, and it only drafts', async () => {
        const onAskAgent = vi.fn();
        const screen = await renderScreen(
            <PaneHarness host="sidebar" snapshot={snapshot({})} onAskAgent={onAskAgent} />,
        );

        expect(screen.findHostByTestId('session-board-empty')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('sessionBoard.empty.editor.title'));
        // The sidebar writes nothing to the Board, so the Add chooser stays out of it.
        expect(screen.findByTestId('session-board-add-trigger')).toBeNull();
        await screen.pressByTestIdAsync('session-board-empty-action');
        expect(onAskAgent).toHaveBeenCalledOnce();
    });

    it('leads an empty editable Board with Ask the agent and keeps Add a note as the quiet second way', async () => {
        const onAskAgent = vi.fn();
        const screen = await renderScreen(
            <Harness snapshot={snapshot({})} onAskAgent={onAskAgent} />,
        );

        await screen.pressByTestIdAsync('session-board-empty-action');
        expect(onAskAgent).toHaveBeenCalledOnce();
        expect(screen.findHostByTestId('session-board-empty-secondary-action')).not.toBeNull();
    });

    it('puts the phone Board\'s Add chooser in the pane header', async () => {
        const screen = await renderScreen(
            <PaneHarness host="mobileCockpit" snapshot={snapshot({ layout: POPULATED, items: [{ itemId: 'note-1', item: note('Plan') }] })} />,
        );

        const header = screen.findByTestId('pane-header');
        expect(header?.findAll((node) => node.props.testID === 'session-board-add-trigger').length).toBeGreaterThan(0);
        expect(screen.findByTestId('pane-header-line')?.props.children).toBe(
            `${t('sessionBoard.sidebar.sharedWithEveryone')} · ${t('sessionBoard.sidebar.widgetCount', { count: 1 })}`,
        );
    });
});

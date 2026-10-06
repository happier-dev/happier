import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionSurfaceNoteDocumentV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { HAPPIER_WIDGET_FRAME_METRICS } from '@happier-dev/plugin-ui/presentation';
import { findGestureByKind } from '@/dev/testkit/mocks/gestureHandler';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { projectSessionBoard, type SessionBoardItemProjection } from '@/sync/domains/session/board';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import type { SessionSurfaceEntityBinding } from './SessionSurfaceEntityDrag';
import { resolveSessionBoardEntityDrop } from './sessionSurfaceEntityDrop';

import {
    SessionWidgetHost,
    type SessionWidgetHostProps,
} from './SessionWidgetHost';

// Escape cancelling an in-flight pointer drag is a keyboard affordance of the
// pointer platforms (web and desktop), so the handle only publishes `onKeyDown`
// there. Under the default node platform runtime that bridge is absent and the
// cancellation case below asserts nothing at all.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

/**
 * The widget card's chrome, as a person actually meets it.
 *
 * These are reach and hierarchy failures rather than type errors: a reorder
 * handle that announces the name of an unrelated control, a rename that only a
 * mouse can start, and a destructive action drawn louder than every constructive
 * one because it is the only control that never went into the menu.
 */

function noteItem(overrides: Partial<SessionSurfaceItemV1> = {}): SessionBoardItemProjection {
    return {
        itemId: 'note-1',
        revision: 'rev-1',
        state: {
            kind: 'ready',
            item: {
                v: 1,
                title: 'Release plan',
                frame: 'card',
                height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Body') },
                ...overrides,
            } as SessionSurfaceItemV1,
        },
    };
}

function unavailableInstalledItem(): SessionBoardItemProjection {
    return {
        itemId: 'plugin-widget-1',
        revision: 'rev-plugin-1',
        state: {
            kind: 'ready',
            item: {
                v: 1,
                title: 'Review status',
                frame: 'card',
                height: { mode: 'auto', fallback: 'regular' },
                source: {
                    kind: 'widget',
                    instance: { v: 1, id: 'plugin-widget-1', bindings: {},
                        definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status' } } },
                },
            } as SessionSurfaceItemV1,
        },
    };
}

const SCOPE = { serverId: 'home-1', accountId: 'account-1' };
const ADDRESS = { serverId: SCOPE.serverId, sessionId: 'session-1' };

function entityDrag(): SessionSurfaceEntityBinding {
    return {
        scope: SCOPE,
        isCurrent: () => true,
        title: 'Release plan',
        getItem: () => ({ kind: 'session-board-item', scope: SCOPE, address: ADDRESS, viewId: 'overview', itemId: 'note-1' }),
    };
}

function boardSnapshot() {
    const item = noteItem();
    if (item.state.kind !== 'ready') throw new Error('Expected ready note fixture');
    return projectSessionBoard({
        layout: { revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', outcome: { status: 'ready', value: {
            v: 1, tabs: [
                { id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }] },
                { id: 'research', title: 'Research', items: [] },
            ],
        } } },
        items: new Map([['note-1', { revision: item.revision ?? 'rev-1', outcome: { status: 'ready' as const, value: item.state.item } }]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
    });
}

async function renderCard(overrides: Partial<SessionWidgetHostProps> = {}) {
    const props: SessionWidgetHostProps = {
        sessionId: 'session-1',
        item: noteItem(),
        host: 'details',
        primaryHost: 'details',
        density: 'full',
        canEdit: true,
        executableCurrentness: 'not_executable',
        width: 'medium',
        heightBounds: { min: 96, max: 520 },
        testID: 'widget',
        ...overrides,
    } as SessionWidgetHostProps;
    return await renderScreen(<SessionWidgetHost {...props} />);
}

function actionsOf(screen: Awaited<ReturnType<typeof renderCard>>): ReadonlyArray<Record<string, unknown>> {
    // The overflow is the person's route to every card operation, so its
    // contents are the contract this card publishes — not an internal detail.
    const trigger = screen.findHostByTestId('widget-actions');
    if (!trigger) return [];
    const owner = screen.tree.root.findAll(
        (node) => Array.isArray((node.props as { actions?: unknown }).actions)
            && (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID === 'widget-actions',
        { deep: true },
    );
    return (owner.at(-1)?.props as { actions: Record<string, unknown>[] } | undefined)?.actions ?? [];
}

function elementHasTestId(
    element: unknown,
    testID: string,
): element is Readonly<{ props: Readonly<{ testID: string }> }> {
    if (typeof element !== 'object' || element === null || !('props' in element)) return false;
    const props = element.props;
    return typeof props === 'object'
        && props !== null
        && 'testID' in props
        && props.testID === testID;
}

describe('SessionWidgetHost chrome', () => {
    it('renders the live walkthrough source rather than reporting it as an unavailable renderer', async () => {
        const screen = await renderCard({
            item: noteItem({ title: 'Walkthrough', source: { kind: 'walkthrough', comparison: 'session' } }),
            serverId: 'home-1',
        });
        expect(screen.findByTestId('widget-walkthrough')).toBeTruthy();
    });
    beforeEach(() => {
        standardCleanup();
    });

    it('publishes a qualified source without requiring a mounted Companion rail and preserves body selection', async () => {
        const screen = await renderCard({ density: 'compact', entityDrag: entityDrag() });
        expect(screen.findHostByTestId('widget-move-handle')).not.toBeNull();
        let bodyParent = screen.findHostByTestId('widget-body')?.parent;
        while (bodyParent && String(bodyParent.type) !== 'GestureDetector') bodyParent = bodyParent.parent;
        expect(bodyParent).toBeNull();
        const runtime = (await renderHook(() => useEntityDragDropRuntime())).getCurrent();
        const pan = findGestureByKind(
            screen.tree.root.findByType('GestureDetector' as never).props.gesture, 'pan',
        );
        await act(async () => { pan?.__handlers.onStart?.({ absoluteX: 50, absoluteY: 50 }); });
        expect(runtime.getSnapshot().item).toEqual(entityDrag().getItem());
        await act(async () => { pan?.__handlers.onFinalize?.(); });
        expect(runtime.getSnapshot().phase).toBe('idle');
    });

    it('names the reorder handle after the item it reorders', async () => {
        const screen = await renderCard({
            entityDrag: entityDrag(),
        });

        const handle = screen.findHostByTestId('widget-move-handle');
        expect(handle).not.toBeNull();
        const label = String((handle?.props as { accessibilityLabel?: string }).accessibilityLabel ?? '');
        // "Board views" is the tab strip beside this card. Borrowing its name
        // tells a screen-reader user they are on the wrong control entirely.
        expect(label).not.toBe('Board views');
        expect(label).toContain('Release plan');
    });

    it('releases through current shared-runtime cross-view admission without a dwell lifecycle', async () => {
        const runtime = (await renderHook(() => useEntityDragDropRuntime())).getCurrent();
        const written: unknown[] = [];
        const board = boardSnapshot();
        const retire = runtime.registerTarget({
            id: 'research', scope: SCOPE, acceptedKinds: ['session-board-item'],
            getBounds: () => ({ x: 800, y: 0, width: 300, height: 800 }),
            resolve: ({ item }) => resolveSessionBoardEntityDrop({
                item, scope: SCOPE, address: ADDRESS, board, viewId: 'research',
                preview: { verb: 'Move to', target: 'Research' },
            }),
            execute: async effect => { written.push(effect.input); return { status: 'applied' }; },
        });
        try {
            const screen = await renderCard({ entityDrag: entityDrag() });
            const pan = findGestureByKind(screen.tree.root.findByType('GestureDetector' as never).props.gesture, 'pan');
            expect(pan).not.toBeNull();
            await act(async () => {
                pan?.__handlers.onStart?.({ absoluteX: 50, absoluteY: 50 });
                pan?.__handlers.onUpdate?.({ absoluteX: 850, absoluteY: 100 });
            });
            expect(written).toEqual([]);
            expect(runtime.getSnapshot().admission?.status).toBe('allowed');
            await act(async () => {
                pan?.__handlers.onEnd?.({ absoluteX: 850, absoluteY: 100 }, true);
                pan?.__handlers.onFinalize?.();
            });
            expect(written).toEqual([{
                sessionId: ADDRESS.sessionId, expectedLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                operation: { op: 'item.move', itemId: 'note-1', fromTabId: 'overview', toTabId: 'research' },
            }]);
        } finally { await act(async () => { retire(); runtime.cancel(); }); }
    });

    it('cancels a pointer carry on Escape before a later successful end can write', async () => {
        const runtime = (await renderHook(() => useEntityDragDropRuntime())).getCurrent();
        const written: unknown[] = [];
        const board = boardSnapshot();
        const retire = runtime.registerTarget({
            id: 'research', scope: SCOPE, acceptedKinds: ['session-board-item'],
            getBounds: () => ({ x: 800, y: 0, width: 300, height: 800 }),
            resolve: ({ item }) => resolveSessionBoardEntityDrop({
                item, scope: SCOPE, address: ADDRESS, board, viewId: 'research',
                preview: { verb: 'Move to', target: 'Research' },
            }),
            execute: async effect => { written.push(effect.input); return { status: 'applied' }; },
        });
        try {
            const screen = await renderCard({ entityDrag: entityDrag() });
            const pan = findGestureByKind(screen.tree.root.findByType('GestureDetector' as never).props.gesture, 'pan');
            const handle = screen.findHostByTestId('widget-move-handle');
            await act(async () => {
                pan?.__handlers.onStart?.({ absoluteX: 50, absoluteY: 50 });
                pan?.__handlers.onUpdate?.({ absoluteX: 850, absoluteY: 100 });
                handle?.props.onKeyDown?.({ key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() });
            });
            expect(runtime.getSnapshot().phase).toBe('idle');
            await act(async () => {
                pan?.__handlers.onEnd?.({ absoluteX: 850, absoluteY: 100 }, true);
                pan?.__handlers.onFinalize?.();
            });
            expect(written).toEqual([]);
        } finally { await act(async () => { retire(); runtime.cancel(); }); }
    });

    it('offers rename to a keyboard and screen reader, not only to a pointer on the title', async () => {
        const screen = await renderCard({ onRename: vi.fn() });

        expect(actionsOf(screen).map((action) => action.id)).toContain('rename');
    });

    it('keeps removal in the menu as the one destructive entry rather than a button under every card', async () => {
        const screen = await renderCard({ onRemove: vi.fn(), onRename: vi.fn() });

        const actions = actionsOf(screen);
        const remove = actions.find((action) => action.id === 'remove');
        expect(remove).toBeDefined();
        expect(remove?.destructive).toBe(true);
        // Last, so the menu never puts a delete next to the pointer's resting place.
        expect(actions.at(-1)?.id).toBe('remove');
        expect(screen.findHostByTestId('widget-remove')).toBeNull();
    });

    it('keeps shared Board removal reachable from compact hosts without confusing it with local placement removal', async () => {
        const remove = vi.fn();
        const screen = await renderCard({ density: 'compact', onRemove: remove });

        const action = actionsOf(screen).find((candidate) => candidate.id === 'remove');
        expect(action?.destructive).toBe(true);
        (action?.onPress as (() => void) | undefined)?.();
        expect(remove).toHaveBeenCalledOnce();
    });

    it('still hides every editing entry from a viewer who cannot edit', async () => {
        const screen = await renderCard({ canEdit: false, onRemove: vi.fn(), onRename: vi.fn() });

        expect(actionsOf(screen).map((action) => action.id)).not.toContain('remove');
    });

    it('keeps plugin management and shared Board removal independently reachable when an installed widget is unavailable', async () => {
        const managePlugin = vi.fn();
        const removeFromBoard = vi.fn();
        const screen = await renderCard({
            item: unavailableInstalledItem(),
            onManagePlugin: managePlugin,
            onRemove: removeFromBoard,
            resolveSourceAvailability: () => ({ kind: 'unavailable', reason: 'plugin_unavailable' }),
        });

        await screen.pressByTestIdAsync('widget-state-action');
        const remove = actionsOf(screen).find((action) => action.id === 'remove');
        expect(remove).toBeDefined();
        (remove?.onPress as (() => void) | undefined)?.();

        expect(managePlugin).toHaveBeenCalledOnce();
        expect(removeFromBoard).toHaveBeenCalledOnce();
        expect(screen.findHostByTestId('widget-state-secondary-action')).toBeNull();
    });

    it('keeps unavailable cards quiet while preserving their recovery actions and expanded explanation', async () => {
        const screen = await renderCard({
            item: unavailableInstalledItem(),
            onManagePlugin: vi.fn(),
            resolveSourceAvailability: () => ({ kind: 'unavailable', reason: 'plugin_unavailable' }),
        });

        expect(screen.findHostByTestId('widget-state')).toBeTruthy();
        expect(screen.findHostByTestId('widget-state-title')).toBeNull();
        expect(screen.findHostByTestId('widget-state-icon')).toBeNull();
        expect(screen.findHostByTestId('widget-state-action')).toBeTruthy();

        standardCleanup();
        const expanded = await renderCard({
            item: unavailableInstalledItem(),
            expanded: true,
            resolveSourceAvailability: () => ({ kind: 'unavailable', reason: 'plugin_unavailable' }),
        });
        expect(expanded.findHostByTestId('widget-state-title')).toBeTruthy();
    });

    it('keeps the Board header clear of any Companion mark', async () => {
        const screen = await renderCard();
        expect(screen.findHostByTestId('widget-companion-mark')).toBeNull();
        expect(screen.findHostByTestId('widget-title')).toBeTruthy();
    });

    it('keeps plugin management available without exposing shared Board removal to a read-only viewer', async () => {
        const managePlugin = vi.fn();
        const removeFromBoard = vi.fn();
        const screen = await renderCard({
            item: unavailableInstalledItem(),
            canEdit: false,
            onManagePlugin: managePlugin,
            onRemove: removeFromBoard,
            resolveSourceAvailability: () => ({
                kind: 'unavailable',
                reason: 'session_widget_contribution_unavailable',
            }),
        });

        await screen.pressByTestIdAsync('widget-state-action');

        expect(managePlugin).toHaveBeenCalledOnce();
        expect(screen.findHostByTestId('widget-state-secondary-action')).toBeNull();
        expect(removeFromBoard).not.toHaveBeenCalled();
    });

    it('consumes one exact post-save focus request on the rendered item heading', async () => {
        const focus = vi.fn();
        const onHeadingFocusHandled = vi.fn();
        await renderScreen(
            <SessionWidgetHost
                sessionId="session-1"
                item={noteItem()}
                host="details"
                primaryHost="details"
                density="full"
                canEdit
                executableCurrentness="not_executable"
                width="medium"
                heightBounds={{ min: 96, max: 520 }}
                focusHeadingRequestId={1}
                onHeadingFocusHandled={onHeadingFocusHandled}
                testID="widget"
            />,
            {
                createNodeMock: (element) => elementHasTestId(element, 'widget-title')
                    ? { focus }
                    : {},
            },
        );

        expect(focus).toHaveBeenCalledOnce();
        expect(onHeadingFocusHandled).toHaveBeenCalledWith(1);
    });

    it('keeps viewer-local Companion placement reachable without requiring Board edit access', async () => {
        const add = vi.fn();
        const screen = await renderCard({
            canEdit: false,
            onAddToCompanion: add,
        });

        const action = actionsOf(screen).find((candidate) => candidate.id === 'add-to-companion');
        expect(action).toBeDefined();
        expect(action?.destructive).not.toBe(true);
        (action?.onPress as (() => void) | undefined)?.();
        expect(add).toHaveBeenCalledTimes(1);
    });

    it('offers the inverse local Companion action when the widget is already selected', async () => {
        const remove = vi.fn();
        const screen = await renderCard({
            canEdit: false,
            onRemoveFromCompanion: remove,
        });

        const action = actionsOf(screen).find((candidate) => candidate.id === 'remove-from-companion');
        expect(action).toBeDefined();
        expect(action?.destructive).not.toBe(true);
        (action?.onPress as (() => void) | undefined)?.();
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('bleeds full-bleed content to the frame edge at every density, and keeps the inset otherwise', async () => {
        const insetOf = async (density: 'full' | 'compact', frame: 'card' | 'full_bleed') => {
            const screen = await renderCard({ density, item: noteItem({ frame }) });
            const body = screen.findHostByTestId('widget.body');
            const style = ([] as unknown[])
                .concat((body?.props as { style?: unknown }).style ?? [])
                .flat(4)
                .filter(Boolean)
                .reduce<Record<string, unknown>>(
                    (accumulator, entry) => ({ ...accumulator, ...(entry as Record<string, unknown>) }),
                    {},
                );
            standardCleanup();
            return style;
        };
        for (const density of ['full', 'compact'] as const) {
            const bleed = await insetOf(density, 'full_bleed');
            expect(bleed.paddingLeft).toBe(0);
            expect(bleed.paddingRight).toBe(0);
            expect(bleed.paddingBottom).toBe(0);
            const inset = await insetOf(density, 'card');
            expect(inset.paddingLeft).toBe(HAPPIER_WIDGET_FRAME_METRICS.cardInsetPx);
        }
    });
});

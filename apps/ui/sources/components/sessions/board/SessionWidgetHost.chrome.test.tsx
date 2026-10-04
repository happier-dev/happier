import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionSurfaceNoteDocumentV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { HAPPIER_WIDGET_FRAME_METRICS } from '@happier-dev/plugin-ui/presentation';
import { findGestureByKind } from '@/dev/testkit/mocks/gestureHandler';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionBoardItemProjection } from '@/sync/domains/session/board';
import { registerSessionCompanionDropTarget } from '@/components/sessions/companion/drop/sessionCompanionDropStore';

import {
    resolveSessionBoardDragVisualOffset,
    SessionWidgetHost,
    type SessionWidgetHostProps,
} from './SessionWidgetHost';

const workletsHarness = vi.hoisted(() => ({
    defer: false,
    pending: [] as Array<() => unknown>,
}));

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
vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => {
        if (workletsHarness.defer) {
            workletsHarness.pending.push(() => callback(...args));
            return;
        }
        return callback(...args);
    },
}));

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
                    kind: 'installedSurface',
                    surface: { pluginId: 'acme.review', localId: 'review-status' },
                },
            } as SessionSurfaceItemV1,
        },
    };
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
        workletsHarness.defer = false;
        workletsHarness.pending = [];
    });

    it('keeps Companion dragging off the body and enables it only while a rail can accept it', async () => {
        const screen = await renderCard({ density: 'compact', onAddToCompanion: vi.fn() });
        const detectorForTitle = (target = screen) => {
            let node = target.findHostByTestId('widget-title')?.parent;
            while (node && String(node.type) !== 'GestureDetector') node = node.parent;
            return node;
        };
        let bodyParent = screen.findHostByTestId('widget-body')?.parent;
        while (bodyParent && String(bodyParent.type) !== 'GestureDetector') bodyParent = bodyParent.parent;
        // An enabled RNGH web detector suppresses selection and scrolling on all descendants.
        expect(bodyParent).toBeNull();
        expect(detectorForTitle()?.props.gesture.__config.enabled).toBe(false);
        let unregister: (() => void) | undefined;
        try {
            await act(async () => {
                unregister = registerSessionCompanionDropTarget('session-1', {
                    measure: async () => ({ x: 800, y: 0, width: 300, height: 800 }),
                    accept: vi.fn(),
                });
            });
            expect(detectorForTitle()?.props.gesture.__config.enabled).toBe(true);
            // Media queries are the real platform boundary, not a mocked pointer decision.
            vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }) });
            const touchScreen = await renderCard({ density: 'compact', onAddToCompanion: vi.fn() });
            expect(detectorForTitle(touchScreen)?.props.gesture.__config.enabled).toBe(false);
            vi.unstubAllGlobals();
            await act(async () => { unregister?.(); });
            expect(detectorForTitle()?.props.gesture.__config.enabled).toBe(false);
        } finally { vi.unstubAllGlobals(); unregister?.(); }
    });

    it('lets the elected mount decide executability, whatever chrome density asks for', async () => {
        // `density` is visual chrome. Collapsing it into the mount decision made the
        // compact sidebar an inert preview even when it was the elected primary host,
        // so the safe single-mount interaction the sidebar promises was unreachable.
        const installed: SessionBoardItemProjection = {
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
                        kind: 'installedSurface',
                        surface: { pluginId: 'acme.review', localId: 'review-status' },
                    },
                } as SessionSurfaceItemV1,
            },
        };
        const available = () => ({ kind: 'available' as const });
        const elected = await renderCard({
            item: installed,
            host: 'sidebar',
            primaryHost: 'sidebar',
            density: 'preview',
            executableCurrentness: 'current',
            resolveSourceAvailability: available,
            onOpenHere: vi.fn(),
        });
        expect(elected.findHostByTestId('widget-open-here')).toBeNull();

        // Another host owns the executable copy: this one truthfully previews.
        const retired = await renderCard({
            item: installed,
            host: 'sidebar',
            primaryHost: 'details',
            density: 'compact',
            executableCurrentness: 'current',
            resolveSourceAvailability: available,
            onOpenHere: vi.fn(),
        });
        expect(retired.findHostByTestId('widget-open-here')).not.toBeNull();
    });

    it('names the reorder handle after the item it reorders', async () => {
        const screen = await renderCard({
            onMove: vi.fn(),
            canMoveBefore: true,
            canMoveAfter: true,
        });

        const handle = screen.findHostByTestId('widget-move-handle');
        expect(handle).not.toBeNull();
        const label = String((handle?.props as { accessibilityLabel?: string }).accessibilityLabel ?? '');
        // "Board views" is the tab strip beside this card. Borrowing its name
        // tells a screen-reader user they are on the wrong control entirely.
        expect(label).not.toBe('Board views');
        expect(label).toContain('Release plan');
    });

    it('keeps a single item attached to a valid cross-view target and commits only that move', async () => {
        const onMoveToView = vi.fn();
        const onMove = vi.fn();
        const onMoveAnchored = vi.fn();
        const screen = await renderCard({
            onMove,
            canMoveBefore: false,
            canMoveAfter: false,
            moveDestinations: [{ id: 'research', title: 'Research' }],
            onMoveToView,
            resolveMoveToView: (_translationX, translationY) => translationY <= -80 ? 'research' : null,
            onMoveAnchored,
            orderedMoveItemIds: ['note-1'],
            moveItemRects: new Map([['note-1', { x: 0, y: 160, width: 240, height: 120 }]]),
        });

        // Same-view edge resistance belongs only to the current ordering path.
        // Once the pointer is over a real view target, the card remains under it
        // even though this one-item view has no before/after neighbour.
        expect(resolveSessionBoardDragVisualOffset({
            translationX: 12,
            translationY: -120,
            canMoveBefore: false,
            canMoveAfter: false,
            crossViewTarget: true,
        })).toEqual({ x: 12, y: -120 });

        // The move handle's detector: the card's own keep-beside-chat detector is disabled here.
        const detector = screen.tree.root.findAll(
            (node) => String(node.type) === 'GestureDetector'
                && (node.props as { gesture?: { __config?: { enabled?: boolean } } }).gesture?.__config?.enabled !== false,
            { deep: true },
        )[0];
        const pan = findGestureByKind(
            (detector?.props as { gesture?: Parameters<typeof findGestureByKind>[0] }).gesture,
            'pan',
        );
        expect(pan).not.toBeNull();

        vi.useFakeTimers();
        act(() => {
            pan?.__handlers.onStart?.();
            pan?.__handlers.onUpdate?.({ translationX: 12, translationY: -120 });
            vi.advanceTimersByTime(500);
            pan?.__handlers.onUpdate?.({ translationX: 12, translationY: -120 });
            pan?.__handlers.onEnd?.({ translationX: 12, translationY: -120 }, true);
            pan?.__handlers.onFinalize?.();
        });
        vi.useRealTimers();

        expect(onMoveToView).toHaveBeenCalledOnce();
        expect(onMoveToView).toHaveBeenCalledWith('research');
        expect(onMove).not.toHaveBeenCalled();
        expect(onMoveAnchored).not.toHaveBeenCalled();
    });

    it('restores an active pointer drag on Escape without allowing its later end event to write', async () => {
        const onMove = vi.fn();
        const onMoveAnchored = vi.fn();
        const screen = await renderCard({
            onMove,
            canMoveBefore: false,
            canMoveAfter: true,
            onMoveAnchored,
            orderedMoveItemIds: ['note-1', 'note-2'],
            moveItemRects: new Map([
                ['note-1', { x: 0, y: 0, width: 100, height: 80 }],
                ['note-2', { x: 116, y: 0, width: 100, height: 80 }],
            ]),
        });
        // The move handle's detector: the card's own keep-beside-chat detector is disabled here.
        const detector = screen.tree.root.findAll(
            (node) => String(node.type) === 'GestureDetector'
                && (node.props as { gesture?: { __config?: { enabled?: boolean } } }).gesture?.__config?.enabled !== false,
            { deep: true },
        )[0];
        const pan = findGestureByKind(
            (detector?.props as { gesture?: Parameters<typeof findGestureByKind>[0] }).gesture,
            'pan',
        );
        const handle = screen.findHostByTestId('widget-move-handle');

        act(() => {
            pan?.__handlers.onStart?.();
            pan?.__handlers.onUpdate?.({ translationX: 140, translationY: 0 });
            handle?.props.onKeyDown?.({
                key: 'Escape',
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
            // Model the real UI-thread/RN boundary: the gesture end can be
            // accepted now and its RN callback can run only after finalize.
            workletsHarness.defer = true;
            pan?.__handlers.onEnd?.({ translationX: 140, translationY: 0 }, true);
            pan?.__handlers.onFinalize?.();
            workletsHarness.defer = false;
            for (const pending of workletsHarness.pending.splice(0)) pending();
        });

        expect(onMove).not.toHaveBeenCalled();
        expect(onMoveAnchored).not.toHaveBeenCalled();
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

    it('keeps the Board header clear when the same widget is in the Companion', async () => {
        const screen = await renderCard({ inCompanion: true });
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

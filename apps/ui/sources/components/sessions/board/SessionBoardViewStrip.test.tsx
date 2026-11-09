// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import type { SessionBoardViewProjection } from '@/sync/domains/session/board';

import { SessionBoardViewStrip } from './SessionBoardViewStrip';

// This file exercises RN Web's roving-tab contract. The shared default runtime
// intentionally reports Platform.OS="node", so use the canonical web boundary
// factory instead of making production expose DOM-only props on native hosts.
vi.mock('react-native', async () => (
    await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock());

/**
 * The inner Board-views selector.
 *
 * It is a tab list, so it must behave like one for the keyboard — and it must use
 * the app's ONE RTL-aware tab-key owner rather than a Board-local Arrow algorithm
 * that quietly moves the wrong way in Arabic or Hebrew.
 */

function view(id: string, title: string | null): SessionBoardViewProjection {
    return { id, title, synthetic: title === null, placements: [] };
}

const VIEWS: readonly SessionBoardViewProjection[] = [
    view('overview', 'Overview'),
    view('research', 'Research'),
    view('ship', 'Ship'),
];

const A11Y_IDS = Object.freeze({
    tabIdPrefix: 'session-board-test-view-tab',
    panelId: 'session-board-test-tabpanel',
});

function readNodeProps(element: unknown): object | null {
    if (typeof element !== 'object' || element === null || !('props' in element)) return null;
    const props = element.props;
    return typeof props === 'object' && props !== null ? props : null;
}

describe('SessionBoardViewStrip', () => {
    it('stays hidden while Overview is the only view', async () => {
        const screen = await renderScreen(
            <SessionBoardViewStrip
                views={[view('overview', null)]}
                activeViewId="overview"
                onSelectView={() => undefined}
                {...A11Y_IDS}
            />,
        );
        expect(screen.findHostByTestId('session-board-views')).toBeNull();
    });

    it('still renders the inline rename editor for the only real view', async () => {
        // After the first saved Note there is exactly one real view. The Rename action
        // stays enabled, so hiding the whole strip made it a silent no-op.
        const onRenameCommit = vi.fn();
        const onRenameCancel = vi.fn();
        const screen = await renderScreen(
            <SessionBoardViewStrip
                views={[view('overview', 'Overview')]}
                activeViewId="overview"
                onSelectView={() => undefined}
                renamingViewId="overview"
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                {...A11Y_IDS}
            />,
        );
        const input = screen.findByTestId('session-board-views-rename-overview');
        expect(input).not.toBeNull();
        await act(async () => { input?.props.onChangeText?.('Planning'); });
        await act(async () => { input?.props.onSubmitEditing?.(); });
        expect(onRenameCommit).toHaveBeenCalledWith('overview', 'Planning');

        // Not renaming: the lone selector stays quiet.
        const quiet = await renderScreen(
            <SessionBoardViewStrip
                views={[view('overview', 'Overview')]}
                activeViewId="overview"
                onSelectView={() => undefined}
                renamingViewId={null}
                {...A11Y_IDS}
            />,
        );
        expect(quiet.findHostByTestId('session-board-views')).toBeNull();
    });

    it('returns focus to the surviving Board action after renaming the only visible view', async () => {
        const fallbackFocus = vi.fn();
        const focusFallbackRef = { current: { focus: fallbackFocus } };
        const screen = await renderScreen(
            <SessionBoardViewStrip
                views={[view('overview', 'Overview')]}
                activeViewId="overview"
                onSelectView={() => undefined}
                renamingViewId="overview"
                focusFallbackRef={focusFallbackRef}
                {...A11Y_IDS}
            />,
        );
        expect(screen.findByTestId('session-board-views-rename-overview')).not.toBeNull();
        await screen.update(
            <SessionBoardViewStrip
                views={[view('overview', 'Planning')]}
                activeViewId="overview"
                onSelectView={() => undefined}
                renamingViewId={null}
                focusFallbackRef={focusFallbackRef}
                {...A11Y_IDS}
            />,
        );
        expect(screen.findHostByTestId('session-board-views')).toBeNull();
        expect(fallbackFocus).toHaveBeenCalledOnce();
    });

    it('moves selection with Arrow keys and wraps at the ends', async () => {
        const onSelectView = vi.fn();
        const screen = await renderScreen(
            <SessionBoardViewStrip views={VIEWS} activeViewId="research" onSelectView={onSelectView} {...A11Y_IDS} />,
        );

        const tab = screen.findByTestId('session-board-views-view-research');
        expect(tab).not.toBeNull();
        tab?.props.onKeyDown?.({ nativeEvent: { key: 'ArrowRight' }, preventDefault: () => undefined });
        expect(onSelectView).toHaveBeenLastCalledWith('ship');

        tab?.props.onKeyDown?.({ nativeEvent: { key: 'Home' }, preventDefault: () => undefined });
        expect(onSelectView).toHaveBeenLastCalledWith('overview');

        tab?.props.onKeyDown?.({ nativeEvent: { key: 'End' }, preventDefault: () => undefined });
        expect(onSelectView).toHaveBeenLastCalledWith('ship');
    });

    it('ignores keys that are not tab navigation', async () => {
        const onSelectView = vi.fn();
        const screen = await renderScreen(
            <SessionBoardViewStrip views={VIEWS} activeViewId="overview" onSelectView={onSelectView} {...A11Y_IDS} />,
        );

        screen.findByTestId('session-board-views-view-overview')?.props.onKeyDown?.({
            nativeEvent: { key: 'a' },
            preventDefault: () => undefined,
        });
        expect(onSelectView).not.toHaveBeenCalled();
    });

    it('carries keyboard focus onto the view it just selected', async () => {
        // Roving focus is two moves, not one. Selecting without moving focus
        // leaves the caret on a control that just became `tabIndex={-1}`, so the
        // next Arrow key reaches nothing and Tab escapes the strip entirely.
        const focusByTestId = new Map<string, ReturnType<typeof vi.fn>>();
        const screen = await renderScreen(
            <SessionBoardViewStrip views={VIEWS} activeViewId="research" onSelectView={() => undefined} {...A11Y_IDS} />,
            {
                createNodeMock: (element) => {
                    const testID = (element.props as { testID?: string }).testID;
                    if (typeof testID !== 'string' || !testID.startsWith('session-board-views-view-')) return {};
                    const focus = vi.fn();
                    focusByTestId.set(testID, focus);
                    return { focus };
                },
            },
        );

        screen.findByTestId('session-board-views-view-research')?.props.onKeyDown?.({
            nativeEvent: { key: 'ArrowRight' },
            preventDefault: () => undefined,
        });

        expect(focusByTestId.get('session-board-views-view-ship')).toHaveBeenCalledOnce();
        expect(focusByTestId.get('session-board-views-view-research')).not.toHaveBeenCalled();
    });

    it('moves focus to the reconciled active tab when the focused view is removed remotely', async () => {
        const focusByTestId = new Map<string, ReturnType<typeof vi.fn>>();
        const screen = await renderScreen(
            <SessionBoardViewStrip views={VIEWS} activeViewId="research" onSelectView={() => undefined} {...A11Y_IDS} />,
            {
                createNodeMock: (element) => {
                    const testID = (element.props as { testID?: string }).testID;
                    if (typeof testID !== 'string' || !testID.startsWith('session-board-views-view-')) return {};
                    const focus = vi.fn();
                    focusByTestId.set(testID, focus);
                    return { focus };
                },
            },
        );

        screen.findByTestId('session-board-views-view-research')?.props.onFocus?.();
        await act(async () => {
            await screen.update(
                <SessionBoardViewStrip
                    views={[VIEWS[0]!, VIEWS[2]!]}
                    activeViewId="ship"
                    onSelectView={() => undefined}
                    {...A11Y_IDS}
                />,
            );
        });

        expect(focusByTestId.get('session-board-views-view-ship')).toHaveBeenCalledOnce();
    });

    it('moves focus to the reconciled active tab after removal started from the selected view action', async () => {
        const focusByTestId = new Map<string, ReturnType<typeof vi.fn>>();
        const onRemovalFocusHandled = vi.fn();
        const screen = await renderScreen(
            <SessionBoardViewStrip
                views={VIEWS}
                activeViewId="research"
                onSelectView={() => undefined}
                removalFocusRequest={null}
                onRemovalFocusHandled={onRemovalFocusHandled}
                {...A11Y_IDS}
            />,
            {
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
            },
        );

        await screen.update(
            <SessionBoardViewStrip
                views={[VIEWS[0]!, VIEWS[2]!]}
                activeViewId="ship"
                onSelectView={() => undefined}
                removalFocusRequest={{ removedViewId: 'research', requestId: 7 }}
                onRemovalFocusHandled={onRemovalFocusHandled}
                {...A11Y_IDS}
            />,
        );

        expect(focusByTestId.get('session-board-views-view-ship')).toHaveBeenCalledOnce();
        expect(onRemovalFocusHandled).toHaveBeenCalledWith(7);
    });

    it('does not steal focus from Board content when an unfocused view is removed remotely', async () => {
        const focusByTestId = new Map<string, ReturnType<typeof vi.fn>>();
        const screen = await renderScreen(
            <SessionBoardViewStrip views={VIEWS} activeViewId="research" onSelectView={() => undefined} {...A11Y_IDS} />,
            {
                createNodeMock: (element) => {
                    const testID = (element.props as { testID?: string }).testID;
                    if (typeof testID !== 'string' || !testID.startsWith('session-board-views-view-')) return {};
                    const focus = vi.fn();
                    focusByTestId.set(testID, focus);
                    return { focus };
                },
            },
        );

        await act(async () => {
            await screen.update(
                <SessionBoardViewStrip
                    views={[VIEWS[0]!, VIEWS[2]!]}
                    activeViewId="ship"
                    onSelectView={() => undefined}
                    {...A11Y_IDS}
                />,
            );
        });

        expect(focusByTestId.get('session-board-views-view-ship')).not.toHaveBeenCalled();
    });

    it('returns focus to the registered Board-view action when removing the last visible tab hides the strip', async () => {
        const fallbackFocus = vi.fn();
        const screen = await renderScreen(
            <SessionBoardViewStrip
                views={VIEWS.slice(0, 2)}
                activeViewId="research"
                onSelectView={() => undefined}
                focusFallbackRef={{ current: { focus: fallbackFocus } }}
                {...A11Y_IDS}
            />,
            {
                createNodeMock: (element) => {
                    const props = readNodeProps(element);
                    if (!props || !('testID' in props) || props.testID !== 'session-board-views-view-research') return {};
                    const onFocus = 'onFocus' in props ? props.onFocus : null;
                    return { focus: () => {
                        if (typeof onFocus === 'function') onFocus();
                    } };
                },
            },
        );

        await act(async () => {
            screen.findByTestId('session-board-views-view-research')?.props.onFocus?.();
        });
        await screen.update(
            <SessionBoardViewStrip
                views={VIEWS.slice(0, 1)}
                activeViewId="overview"
                onSelectView={() => undefined}
                focusFallbackRef={{ current: { focus: fallbackFocus } }}
                {...A11Y_IDS}
            />,
        );

        expect(fallbackFocus).toHaveBeenCalledOnce();
    });

    it('draws a visible focus ring so a keyboard user can see where they are', async () => {
        const screen = await renderScreen(
            <SessionBoardViewStrip views={VIEWS} activeViewId="research" onSelectView={() => undefined} {...A11Y_IDS} />,
        );

        // RN Web's focused flag also follows pointer/script focus. The shared
        // focus owner needs the browser's keyboard modality and focused element.
        const focusTarget = document.createElement('button');
        document.body.appendChild(focusTarget);
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            focusTarget.focus();
            await act(async () => {
                screen.findByTestId('session-board-views-view-ship')?.props.onFocus?.({ target: focusTarget });
            });
            const tab = screen.findByTestId('session-board-views-view-ship');
            const focused = flattenTestStyle(
                (tab?.props.style as ((state: { pressed: boolean; focused: boolean }) => unknown))?.({
                    pressed: false,
                    focused: true,
                }),
            );

            expect(Number(focused.outlineWidth ?? 0)).toBeGreaterThanOrEqual(2);
            expect(focused.outlineColor).toBeTruthy();
        } finally {
            focusTarget.remove();
            document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        }
    });

    it('keeps only the selected view in the tab order so the strip is one tab stop', async () => {
        const screen = await renderScreen(
            <SessionBoardViewStrip views={VIEWS} activeViewId="research" onSelectView={() => undefined} {...A11Y_IDS} />,
        );

        expect(screen.findByTestId('session-board-views-view-research')?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('session-board-views-view-ship')?.props.tabIndex).toBe(-1);
    });

    it('connects every tab to the active panel with stable DOM identities', async () => {
        const screen = await renderScreen(
            <SessionBoardViewStrip
                views={VIEWS}
                activeViewId="research"
                onSelectView={() => undefined}
                tabIdPrefix="session-board-r0-view-tab"
                panelId="session-board-r0-tabpanel"
            />,
        );

        const research = screen.findByTestId('session-board-views-view-research');
        const ship = screen.findByTestId('session-board-views-view-ship');
        expect(research?.props.nativeID).toBe('session-board-r0-view-tab-research');
        expect(ship?.props.nativeID).toBe('session-board-r0-view-tab-ship');
        expect(research?.props['aria-controls']).toBe('session-board-r0-tabpanel');
        expect(ship?.props['aria-controls']).toBe('session-board-r0-tabpanel');
    });
});

import * as React from 'react';
import { Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { act } from 'react-test-renderer';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { renderScreen } from '@/dev/testkit';

import {
    SessionListSelectionProvider,
    useSessionListSelectionActions,
} from './SessionListSelectionContext';
import { SessionListSelectionActionBarHost } from './SessionListSelectionActionBar';
import { SESSION_BULK_ACTION_IDS, type SessionBulkActionTarget } from '@/components/sessions/actions/sessionBulkActionTypes';

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        useWindowDimensions: vi.fn(() => ({ width: 390, height: 840, scale: 1, fontScale: 1 })),
        Platform: {
            ...actual.Platform,
            OS: 'web',
        },
    };
});

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitBottomChromeHeight: vi.fn(() => 0),
}));

function ActionBarHarness() {
    const targetsByKey = React.useMemo(() => new Map<string, SessionBulkActionTarget>([
        ['session-a', {
            key: 'session-a',
            sessionId: 'session-a',
            serverId: 'server-a',
            active: true,
            archived: false,
            pinned: false,
            readState: 'unread',
        }],
        ['session-b', {
            key: 'session-b',
            sessionId: 'session-b',
            serverId: 'server-a',
            active: false,
            archived: false,
            pinned: false,
            readState: 'unread',
        }],
    ]), []);
    return (
        <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['session-a', 'session-b']}>
            <SelectionControls />
            <SessionListSelectionActionBarHost
                targetsByKey={targetsByKey}
                bulkActionContext={{
                    setSessionPin: async () => undefined,
                    setManualReadState: async (target) => target.sessionId === 'session-b'
                        ? { success: false, message: 'failed' }
                        : { success: true },
                    stopSession: async () => ({ success: true }),
                    archiveSession: async () => ({ success: true }),
                    stopSessionAndMaybeArchive: async () => undefined,
                }}
            />
        </SessionListSelectionProvider>
    );
}

function SelectionControls() {
    const actions = useSessionListSelectionActions();
    return (
        <>
            <ProbeButton testID="select-session-a" onPress={() => actions.replaceWith('session-a')} />
            <ProbeButton testID="select-all-sessions" onPress={() => actions.selectAllVisible()} />
            <ProbeButton testID="enter-selection-mode" onPress={() => actions.enter()} />
        </>
    );
}

function ProbeButton(props: React.PropsWithChildren<{ testID: string; onPress: () => void }>) {
    return React.createElement('ProbeButton', props, props.children);
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    return (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
}

async function pressByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Promise<void> {
    const button = screen.findByProps({ testID });
    await act(async () => {
        button.props.onPress();
    });
}

describe('SessionListSelectionActionBarHost', () => {
    afterEach(() => {
        vi.mocked(useWindowDimensions).mockReturnValue({ width: 390, height: 840, scale: 1, fontScale: 1 });
        vi.mocked(useSessionCockpitBottomChromeHeight).mockReturnValue(0);
        Platform.OS = 'web';
    });

    it('renders the stable e2e action bar and selected-count selector contract', async () => {
        const screen = await renderScreen(<ActionBarHarness />);
        expect(screen.findByTestId('session-list-selection-action-bar')).toBeNull();

        const button = screen.findByProps({ testID: 'select-session-a' });
        await act(async () => {
            button.props.onPress();
        });

        const actionBar = screen.findByTestId('session-list-selection-action-bar');
        expect(actionBar).toBeTruthy();
        const count = screen.findByProps({ testID: 'session-list-selection-count' });
        expect(count.props['data-selected-count']).toBe(1);
    });

    it('keeps the shell visible with a zero count while explicit selection mode is active', async () => {
        const screen = await renderScreen(<ActionBarHarness />);

        await pressByTestId(screen, 'enter-selection-mode');

        const actionBar = screen.findByTestId('session-list-selection-action-bar');
        expect(actionBar).toBeTruthy();
        const count = screen.findByProps({ testID: 'session-list-selection-count' });
        expect(count.props['data-selected-count']).toBe(0);
    });

    it('executes a bulk local action and renders a result selector before dismissing', async () => {
        const setSessionPin = vi.fn(async () => undefined);
        const targetsByKey = new Map<string, SessionBulkActionTarget>([
            ['session-a', {
                key: 'session-a',
                sessionId: 'session-a',
                serverId: 'server-a',
                pinned: false,
            }],
        ]);
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['session-a']}>
                <SelectionControls />
                <SessionListSelectionActionBarHost
                    targetsByKey={targetsByKey}
                    bulkActionContext={{
                        setSessionPin,
                    }}
                />
            </SessionListSelectionProvider>,
        );

        await pressByTestId(screen, 'select-session-a');
        await pressByTestId(screen, 'session-list-selection-action-session-pin');

        expect(setSessionPin).toHaveBeenCalledWith({
            target: expect.objectContaining({ key: 'session-a', sessionId: 'session-a' }),
            pinned: true,
        });
        const result = screen.findByProps({ testID: 'session-list-selection-result' });
        expect(result.props['data-action-id']).toBe(SESSION_BULK_ACTION_IDS.pin);
        expect(result.props['data-succeeded-count']).toBe(1);
        expect(result.props['data-failed-count']).toBe(0);
        expect(result.props['data-skipped-count']).toBe(0);

        await pressByTestId(screen, 'session-list-selection-result-dismiss');
        expect(screen.findByTestId('session-list-selection-action-bar')).toBeNull();
    });

    it('executes a bulk attention-standing action through the injected operation', async () => {
        const setSessionAttentionStanding = vi.fn(async () => undefined);
        const targetsByKey = new Map<string, SessionBulkActionTarget>([
            ['session-a', {
                key: 'session-a',
                sessionId: 'session-a',
                serverId: 'server-a',
                pinned: false,
                standing: false,
            }],
        ]);
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['session-a']}>
                <SelectionControls />
                <SessionListSelectionActionBarHost
                    targetsByKey={targetsByKey}
                    bulkActionContext={{
                        setSessionAttentionStanding,
                    }}
                />
            </SessionListSelectionProvider>,
        );

        await pressByTestId(screen, 'select-session-a');
        await pressByTestId(screen, 'session-list-selection-action-session-set-attention-standing');

        expect(setSessionAttentionStanding).toHaveBeenCalledWith({
            target: expect.objectContaining({ key: 'session-a', sessionId: 'session-a' }),
            standing: true,
        });
        const result = screen.findByProps({ testID: 'session-list-selection-result' });
        expect(result.props['data-action-id']).toBe(SESSION_BULK_ACTION_IDS.setAttentionStanding);
        expect(result.props['data-succeeded-count']).toBe(1);
    });

    it('keeps failed targets selected after a partial bulk result', async () => {
        const screen = await renderScreen(<ActionBarHarness />);

        await pressByTestId(screen, 'select-all-sessions');
        await pressByTestId(screen, 'session-list-selection-action-session-mark-read');

        const result = screen.findByProps({ testID: 'session-list-selection-result' });
        expect(result.props['data-action-id']).toBe(SESSION_BULK_ACTION_IDS.markRead);
        expect(result.props['data-succeeded-count']).toBe(1);
        expect(result.props['data-failed-count']).toBe(1);
        expect(result.props['data-skipped-count']).toBe(0);

        const count = screen.findByProps({ testID: 'session-list-selection-count' });
        expect(count.props['data-selected-count']).toBe(1);
    });

    it('selects all visible sessions from the action bar', async () => {
        const screen = await renderScreen(<ActionBarHarness />);

        await pressByTestId(screen, 'select-session-a');

        const selectAll = screen.findByProps({ testID: 'session-list-selection-select-all-visible' });
        expect(selectAll).toBeTruthy();

        await act(async () => {
            selectAll.props.onPress();
        });

        const count = screen.findByProps({ testID: 'session-list-selection-count' });
        expect(count.props['data-selected-count']).toBe(2);
        expect(screen.findByTestId('session-list-selection-select-all-visible')).toBeNull();
    });

    it('executes confirmed actions against the originally confirmed selection snapshot', async () => {
        const stoppedSessionIds: string[] = [];
        const targetsByKey = new Map<string, SessionBulkActionTarget>([
            ['session-a', {
                key: 'session-a',
                sessionId: 'session-a',
                serverId: 'server-a',
                active: true,
                canStop: true,
            }],
            ['session-b', {
                key: 'session-b',
                sessionId: 'session-b',
                serverId: 'server-a',
                active: true,
                canStop: true,
            }],
        ]);
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['session-a', 'session-b']}>
                <SelectionControls />
                <SessionListSelectionActionBarHost
                    targetsByKey={targetsByKey}
                    bulkActionContext={{
                        stopSession: async (target) => {
                            stoppedSessionIds.push(target.sessionId);
                            return { success: true };
                        },
                    }}
                />
            </SessionListSelectionProvider>,
        );

        await pressByTestId(screen, 'select-session-a');
        await pressByTestId(screen, 'session-list-selection-action-session-stop');
        await pressByTestId(screen, 'select-all-sessions');
        await pressByTestId(screen, 'session-list-selection-confirm-session-stop');

        expect(stoppedSessionIds).toEqual(['session-a']);
    });

    it('shows inline confirmation and progress for long-running stop actions', async () => {
        let resolveStop: (() => void) | null = null;
        const stopPromise = new Promise<void>((resolve) => {
            resolveStop = resolve;
        });
        const targetsByKey = new Map<string, SessionBulkActionTarget>([
            ['session-a', {
                key: 'session-a',
                sessionId: 'session-a',
                serverId: 'server-a',
                active: true,
                canStop: true,
            }],
        ]);
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['session-a']}>
                <SelectionControls />
                <SessionListSelectionActionBarHost
                    targetsByKey={targetsByKey}
                    bulkActionContext={{
                        stopSession: async () => {
                            await stopPromise;
                            return { success: true };
                        },
                    }}
                />
            </SessionListSelectionProvider>,
        );

        await pressByTestId(screen, 'select-session-a');
        await pressByTestId(screen, 'session-list-selection-action-session-stop');

        const confirm = screen.findByProps({ testID: 'session-list-selection-confirm-session-stop' });
        expect(confirm).toBeTruthy();

        await act(async () => {
            confirm.props.onPress();
            await Promise.resolve();
        });

        const progress = screen.findByProps({ testID: 'session-list-selection-progress' });
        expect(progress.props['data-action-id']).toBe(SESSION_BULK_ACTION_IDS.stop);

        await act(async () => {
            resolveStop?.();
            await stopPromise;
            await Promise.resolve();
        });

        const result = screen.findByProps({ testID: 'session-list-selection-result' });
        expect(result.props['data-succeeded-count']).toBe(1);
    });

    it('floats above the measured bottom chrome so its actions are not hidden behind the tab bar', async () => {
        Platform.OS = 'ios';
        vi.mocked(useWindowDimensions).mockReturnValue({ width: 390, height: 840, scale: 1, fontScale: 1 });
        vi.mocked(useSessionCockpitBottomChromeHeight).mockReturnValue(80);
        const screen = await renderScreen(
            <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 34, left: 0 }}>
                <ActionBarHarness />
            </SafeAreaInsetsContext.Provider>,
        );

        await pressByTestId(screen, 'select-session-a');

        const host = screen.findByProps({ testID: 'session-list-selection-action-bar-host' });
        const flattenedStyle = Array.isArray(host.props.style)
            ? Object.assign({}, ...host.props.style.filter(Boolean))
            : host.props.style;
        expect(flattenedStyle.bottom).toBeGreaterThanOrEqual(80); // clears the mocked 80px tab bar (no overlap)
    });

    it('uses a compact horizontally scrollable action row on short native screens', async () => {
        Platform.OS = 'ios';
        vi.mocked(useWindowDimensions).mockReturnValue({ width: 390, height: 680, scale: 1, fontScale: 1 });
        const screen = await renderScreen(<ActionBarHarness />);

        await pressByTestId(screen, 'select-session-a');

        const actionRows = screen.findAllByProps({ testID: 'session-list-selection-actions-scroll' });
        expect(actionRows.some((row) => row.props.horizontal === true)).toBe(true);
        expect(screen.findByProps({ testID: 'session-list-selection-actions-scroll-content' })).toBeTruthy();
    });

    it('contains the compact horizontal actions inside the list-width action bar', async () => {
        vi.mocked(useWindowDimensions).mockReturnValue({ width: 390, height: 680, scale: 1, fontScale: 1 });
        const screen = await renderScreen(<ActionBarHarness />);

        await pressByTestId(screen, 'select-session-a');

        const host = screen.findByProps({ testID: 'session-list-selection-action-bar-host' });
        const actionBar = screen.findByTestId('session-list-selection-action-bar');
        const actionScroll = screen.findByProps({ testID: 'session-list-selection-actions-scroll' });

        expect(flattenStyle(host.props.style)).toMatchObject({ alignItems: 'stretch' });
        expect(flattenStyle(actionBar!.props.style)).toMatchObject({ width: '100%' });
        expect(flattenStyle(actionScroll.parent?.props.style)).toMatchObject({ width: '100%' });
    });

    it('executes actions for selected targets hidden by a collapsed group', async () => {
        const setSessionPin = vi.fn(async () => undefined);
        const targetsByKey = new Map<string, SessionBulkActionTarget>([
            ['session-a', {
                key: 'session-a',
                sessionId: 'session-a',
                serverId: 'server-a',
                active: false,
                archived: false,
                pinned: false,
            }],
            ['session-b', {
                key: 'session-b',
                sessionId: 'session-b',
                serverId: 'server-a',
                active: false,
                archived: false,
                pinned: false,
            }],
        ]);
        function HiddenSelectionHarness() {
            const actions = useSessionListSelectionActions();
            React.useEffect(() => {
                actions.setSelectedKeys(['session-b']);
            }, [actions]);
            return (
                <SessionListSelectionActionBarHost
                    targetsByKey={targetsByKey}
                    bulkActionContext={{
                        setSessionPin,
                    }}
                />
            );
        }

        const screen = await renderScreen(
            <SessionListSelectionProvider
                scopeKey="scope-a"
                visibleOrderedKeys={['session-a']}
                eligibleKeys={['session-a', 'session-b']}
            >
                <HiddenSelectionHarness />
            </SessionListSelectionProvider>,
        );

        await pressByTestId(screen, 'session-list-selection-action-session-pin');

        expect(setSessionPin).toHaveBeenCalledWith({
            target: expect.objectContaining({ key: 'session-b', sessionId: 'session-b' }),
            pinned: true,
        });
    });
});

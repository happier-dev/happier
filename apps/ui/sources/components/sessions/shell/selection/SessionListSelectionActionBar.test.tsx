import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { act } from 'react-test-renderer';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { renderScreen } from '@/dev/testkit';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { SESSION_RECIPIENT_CHIP_KEY } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { clearTempData } from '@/utils/sessions/tempDataStore';

import {
    SessionListSelectionProvider,
    useSessionListSelectionActions,
} from './SessionListSelectionContext';
import { SessionListSelectionActionBarHost, type SessionListSelectionActionBarHostProps } from './SessionListSelectionActionBar';
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

vi.mock('react-native-safe-area-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native-safe-area-context')>();
    const ReactModule = await import('react');
    return {
        ...actual,
        SafeAreaInsetsContext: actual.SafeAreaInsetsContext ?? ReactModule.createContext(null),
    };
});

const routerBoundary = vi.hoisted(() => ({ push: null as null | ((href: unknown) => void) }));
vi.mock('expo-router', async () => {
    const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/' });
    routerBoundary.push = mock.spies.push;
    return mock.module;
});

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitBottomChromeHeight: vi.fn(() => 0),
    // The shared bar's pinned placement reads the page clearance; this list positions its own host.
    useSessionCockpitPageBottomClearance: vi.fn(() => 0),
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


async function pressByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Promise<void> {
    const button = screen.findByProps({ testID });
    await act(async () => {
        button.props.onPress();
    });
}

describe('SessionListSelectionActionBarHost', () => {
    it('leads with Compose, which opens the bulk composer aimed at the selected Sessions', async () => {
        const { takeBulkSessionComposerSeed } = await import('@/components/sessions/authoring/bulk/bulkSessionComposerHandoff');
        const screen = await renderScreen(<ActionBarHarness />);
        await pressByTestId(screen, 'select-all-sessions');
        const compose = screen.findByProps({ testID: 'session-list-selection-action-compose' });
        expect(compose.props.accessibilityLabel ?? compose.props.label ?? 'Compose').toBeTruthy();
        await act(async () => { compose.props.onPress(); });
        const href = vi.mocked(routerBoundary.push!).mock.calls.at(-1)?.[0] as { pathname: string; params: { dataId: string } };
        expect(href.pathname).toBe('/session/compose');
        expect(takeBulkSessionComposerSeed(href.params.dataId)?.targets).toEqual([
            { serverId: 'server-a', sessionId: 'session-a' },
            { serverId: 'server-a', sessionId: 'session-b' },
        ]);
    });

    it('opens the new list selection when the same Compose tab body is retained', async () => {
        const { WorkspaceRouteBody } = await import('@/app/(app)/session/compose');
        const list = await renderScreen(<ActionBarHarness />);
        const compose = async (selectionTestId: string) => {
            await pressByTestId(list, selectionTestId);
            await pressByTestId(list, 'session-list-selection-action-compose');
            const href = vi.mocked(routerBoundary.push!).mock.calls.at(-1)?.[0] as
                { pathname: string; params: { dataId: string } };
            return href.params.dataId;
        };
        const body = (dataId: string) => (
            <DestinationInstanceContext.Provider value={{
                tabId: 'compose-tab', pathname: '/session/compose', focused: true, visible: true,
                isFocused: () => true, ref: { kind: 'sessions.compose', params: { dataId } },
                navigation: { push: () => {}, replace: () => {}, back: () => {} },
            }}>
                <WorkspaceRouteBody />
            </DestinationInstanceContext.Provider>
        );
        const first = await compose('select-all-sessions');
        const screen = await renderScreen(body(first));
        try {
            const selectedIds = () => {
                const chips: readonly AgentInputExtraActionChip[] = screen.findByType(AgentInput).props.extraActionChips;
                const selection = chips.find(chip => chip.key === SESSION_RECIPIENT_CHIP_KEY)?.collapsedOptionsPopover?.selection;
                return selection?.kind === 'multiple' ? [...selection.selectedIds] : [];
            };
            const a = sessionAddressKey({ serverId: 'server-a', sessionId: 'session-a' });
            const b = sessionAddressKey({ serverId: 'server-a', sessionId: 'session-b' });
            expect(selectedIds()).toEqual([a, b]);
            const second = await compose('select-session-a');
            expect(second).not.toBe(first);
            await screen.update(body(second));
            expect(selectedIds()).toEqual([a]);
        } finally {
            await screen.unmount();
            await list.unmount();
            clearTempData();
        }
    });

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

    it('reports failed folder-picker preparation and preserves selected sessions', async () => {
        const targetsByKey = new Map<string, SessionBulkActionTarget>([
            ['session-a', { key: 'session-a', sessionId: 'session-a', serverId: 'server-a', canMoveToFolder: true }],
        ]);
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['session-a']}>
                <SelectionControls />
                <SessionListSelectionActionBarHost
                    targetsByKey={targetsByKey}
                    onRequestMoveToFolder={async () => { throw new Error('Folder picker unavailable'); }}
                />
            </SessionListSelectionProvider>,
        );
        await pressByTestId(screen, 'select-session-a');
        await act(async () => {
            await screen.findByProps({ testID: 'session-list-selection-action-session-move-to-folder' }).props.onPress();
        });
        const result = screen.findByProps({ testID: 'session-list-selection-result' });
        expect(result.props['data-failed-count']).toBe(1);
        expect(result.props['data-succeeded-count']).toBe(0);
        expect(screen.findByProps({ testID: 'session-list-selection-count' }).props['data-selected-count']).toBe(1);
    });

    it('retains the picker-captured filing context and partial outcomes', async () => {
        type Choice = Awaited<ReturnType<NonNullable<SessionListSelectionActionBarHostProps['onRequestMoveToFolder']>>>;
        let resolvePicker!: (choice: Choice) => void;
        const picker = new Promise<Choice>(resolve => { resolvePicker = resolve; });
        const writes: string[] = [];
        const targetsByKey = new Map<string, SessionBulkActionTarget>(['session-a', 'session-b'].map(sessionId => [sessionId,
            { key: sessionId, sessionId, serverId: 'server-a', canMoveToFolder: true }] as const));
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['session-a', 'session-b']}>
                <SelectionControls />
                <SessionListSelectionActionBarHost targetsByKey={targetsByKey}
                    bulkActionContext={{ foldersFeatureDecision: { state: 'enabled' },
                        setSessionFolderAssignment: async () => { throw new Error('Must not select a later operation context'); } }}
                    onRequestMoveToFolder={() => picker} />
            </SessionListSelectionProvider>,
        );
        await pressByTestId(screen, 'select-all-sessions');
        let operation: Promise<void> | undefined;
        await act(async () => {
            operation = screen.findByProps({ testID: 'session-list-selection-action-session-move-to-folder' }).props.onPress();
        });
        expect(writes).toEqual([]);
        await act(async () => {
            resolvePicker({ folderId: 'launch', destinationServerId: 'server-a', executionContext: {
                // This is the captured external mutation boundary, not a second bulk implementation.
                setSessionFolderAssignment: async ({ target }) => {
                    writes.push(target.sessionId);
                    if (target.sessionId === 'session-b') throw new Error('permission_denied');
                },
            } });
            await operation;
        });
        expect(writes).toEqual(['session-a', 'session-b']);
        const result = screen.findByProps({ testID: 'session-list-selection-result' });
        expect(result.props['data-succeeded-count']).toBe(1);
        expect(result.props['data-failed-count']).toBe(1);
        expect(screen.findByProps({ testID: 'session-list-selection-count' }).props['data-selected-count']).toBe(1);
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

    it('executes Stop directly against the selection captured when pressed', async () => {
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
        expect(screen.findByTestId('session-list-selection-confirm-session-stop')).toBeNull();
        await pressByTestId(screen, 'select-all-sessions');

        expect(stoppedSessionIds).toEqual(['session-a']);
    });

    it('shows progress directly for long-running Stop actions', async () => {
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

        expect(screen.findByTestId('session-list-selection-confirm-session-stop')).toBeNull();

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

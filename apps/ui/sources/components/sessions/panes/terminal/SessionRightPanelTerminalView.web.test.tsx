import { createDeferred, flushHookEffects, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineTerminalEnsureSpy = vi.fn();
const machineTerminalRestartSpy = vi.fn();
const machineTerminalStreamReadSpy = vi.fn();
const machineTerminalResizeSpy = vi.fn();
const storageGetStateSpy = vi.fn();
const terminalHandleInstances: Array<{
    write: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
}> = [];

let shouldTriggerResizeAfterReady = false;
let terminalRendererVersion = 0;
let activeScreen: RenderScreenResult | null = null;
let sessionState: any = { metadata: { machineId: 'machine-1', path: '/tmp' } };
let projectState: any = null;

installSessionDetailsPanelCommonModuleMocks({
    storage: async () => ({
        useLocalSetting: (key: string) => {
            if (key === 'uiFontScale') return 1;
            if (key === 'embeddedTerminalDockLocation') return 'sidebar';
            return null;
        },
        useLocalSettingMutable: (key: string) => {
            if (key === 'embeddedTerminalDockLocation') return ['sidebar', vi.fn()];
            return [null, vi.fn()];
        },
        useAllMachines: () => Object.values(storageGetStateSpy()?.machines ?? {}),
        useAllSessions: () => Object.values(storageGetStateSpy()?.sessions ?? {}),
        useProjectForSession: () => projectState,
        useSession: () => sessionState,
        storage: {
            getState: () => storageGetStateSpy(),
        },
    }),
});

async function renderAndFlush(element: React.ReactElement): Promise<RenderScreenResult> {
    const screen = await renderScreen(element);
    activeScreen = screen;
    await flushHookEffects();
    return screen;
}

async function loadSessionRightPanelTerminalViewWeb() {
    const mod = await import('./SessionRightPanelTerminalView.web');
    return mod.SessionRightPanelTerminalView;
}

async function loadSessionEmbeddedTerminalPaneWeb() {
    const mod = await import('@/components/sessions/terminal/SessionEmbeddedTerminalPane.web');
    return mod.SessionEmbeddedTerminalPane;
}

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: (props: any) => React.createElement('PrimaryCircleIconButton', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/code/editor/codeEditorFontMetrics', () => ({
    resolveCodeEditorFontMetrics: () => ({ fontSize: 12 }),
}));

vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef((props: any, ref: any) => {
        const handle = React.useMemo(() => ({
            write: vi.fn(),
            clear: vi.fn(),
            focus: vi.fn(),
            hasSelection: () => false,
            getSelectionText: () => '',
        }), [terminalRendererVersion]);

        React.useImperativeHandle(ref, () => ({
            ...handle,
            hasSelection: () => false,
            getSelectionText: () => '',
        }), [handle]);

        React.useEffect(() => {
            terminalHandleInstances.push(handle);
        }, [handle]);

        React.useEffect(() => {
            props.onReady(80, 24);
            if (!shouldTriggerResizeAfterReady) {
                return;
            }
            void Promise.resolve().then(() => {
                props.onResize(81, 24);
            });
        }, [props.onReady]);

        return React.createElement('XtermTerminalView', props);
    }),
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineRpcTargetAvailable: true }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: 'session:s1',
        scopeState: {
            right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
        },
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalEnsure: (...args: any[]) => machineTerminalEnsureSpy(...args),
    machineTerminalRestart: (...args: any[]) => machineTerminalRestartSpy(...args),
    machineTerminalStreamRead: (...args: any[]) => machineTerminalStreamReadSpy(...args),
    machineTerminalInput: vi.fn(),
    machineTerminalResize: (...args: any[]) => machineTerminalResizeSpy(...args),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: vi.fn(),
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: vi.fn(),
}));

describe('SessionRightPanelTerminalView.web', () => {
    beforeEach(() => {
        vi.resetModules();
        shouldTriggerResizeAfterReady = false;
        terminalRendererVersion = 0;
        activeScreen = null;
        terminalHandleInstances.length = 0;
        sessionState = { metadata: { machineId: 'machine-1', path: '/tmp' } };
        projectState = null;
        storageGetStateSpy.mockReset();
        storageGetStateSpy.mockReturnValue({
            sessions: {
                s1: sessionState,
            },
            machines: {
                'machine-1': {
                    id: 'machine-1',
                    active: true,
                    activeAt: Date.now(),
                    metadata: { host: 'mbp.local' },
                },
            },
            getProjectForSession: () => projectState,
        });
        machineTerminalEnsureSpy.mockReset();
        machineTerminalRestartSpy.mockReset();
        machineTerminalStreamReadSpy.mockReset();
        machineTerminalResizeSpy.mockReset();

        machineTerminalEnsureSpy.mockResolvedValue({ ok: true, terminalId: 't1', reused: false });
        machineTerminalRestartSpy.mockResolvedValue({ ok: true, terminalId: 't2', reused: false });
        machineTerminalResizeSpy.mockResolvedValue({ ok: true });
        machineTerminalStreamReadSpy.mockImplementation(async (_machineId: string, input: any) => ({
            ok: true,
            terminalId: input.terminalId,
            events: [],
            nextCursor: 0,
            done: true,
        }));
    });

    afterEach(async () => {
        if (activeScreen) {
            await activeScreen.unmount();
            activeScreen = null;
        }
        terminalHandleInstances.length = 0;
    });

    it('restarts the PTY when the user presses restart', async () => {
        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();
        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);

        const restartButton = screen.findByTestId('session-rightpanel-terminal-restart');
        expect(restartButton).toBeTruthy();

        await screen.pressByTestIdAsync('session-rightpanel-terminal-restart');

        await flushHookEffects();

        expect(machineTerminalRestartSpy).toHaveBeenCalledTimes(1);
    });

    it('uses a canonical session-scoped terminalKey', async () => {
        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId="session:s1"
                currentDockLocation="details"
                testIdPrefix="pane-a"
            />,
        );

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
        const ensureInput = machineTerminalEnsureSpy.mock.calls[0]?.[1];
        expect(ensureInput?.terminalKey).toBe('session:s1:terminal');
    });

    it('uses the resolved session machine target when the session machine id is stale', async () => {
        sessionState = {
            metadata: {
                machineId: 'm-stale',
                path: '/workspace/repo',
                host: 'mbp.local',
            },
        };
        projectState = {
            key: {
                machineId: 'm-project',
                path: '/workspace/repo',
            },
        };
        storageGetStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: sessionState.metadata,
                },
            },
            machines: {
                'm-project': {
                    id: 'm-project',
                    active: true,
                    activeAt: Date.now(),
                    metadata: { host: 'mbp.local' },
                },
            },
            getProjectForSession: () => projectState,
        });

        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId="session:s1"
                currentDockLocation="details"
                testIdPrefix="pane-a"
            />,
        );

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
        expect(machineTerminalEnsureSpy.mock.calls[0]?.[0]).toBe('m-project');
        expect(machineTerminalEnsureSpy.mock.calls[0]?.[1]?.cwd).toBe('/workspace/repo');
    });

    it('does not re-ensure the PTY session when the terminal resizes', async () => {
        shouldTriggerResizeAfterReady = true;

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);
        await flushHookEffects();

        expect(screen.tree).toBeTruthy();
        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
    });

    it('retries automatically when initial ensure hits rpc method unavailable', async () => {
        machineTerminalEnsureSpy
            .mockRejectedValueOnce(createRpcCallError({
                error: 'RPC method not available',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }))
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        await flushHookEffects();

        expect(screen.findByTestId('session-rightpanel-terminal-retry')).toBeNull();
    });

    it('preserves the stream cursor when auto-retrying after a transient read error', async () => {
        machineTerminalEnsureSpy
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });

        machineTerminalStreamReadSpy.mockReset();
        machineTerminalStreamReadSpy
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'hello' }],
                nextCursor: 5,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'terminal_not_found',
                error: 'terminal_not_found',
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'world' }],
                nextCursor: 6,
                done: true,
            });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        await flushHookEffects();

        const thirdReadArgs = machineTerminalStreamReadSpy.mock.calls[2]?.[1];
        expect(thirdReadArgs?.cursor).toBe(5);
        expect(screen.findByTestId('session-rightpanel-terminal-retry')).toBeNull();
    });

    it('preserves the stream cursor when auto-retrying after a stream read timeout', async () => {
        machineTerminalEnsureSpy
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });

        machineTerminalStreamReadSpy.mockReset();
        machineTerminalStreamReadSpy
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'hello' }],
                nextCursor: 5,
                done: false,
            })
            .mockRejectedValueOnce(new Error('operation has timed out'))
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'world' }],
                nextCursor: 6,
                done: true,
            });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        await flushHookEffects();

        expect(machineTerminalStreamReadSpy.mock.calls[2]?.[1]?.cursor).toBe(5);

        expect(screen.findByTestId('session-rightpanel-terminal-retry')).toBeNull();
    });

    it('hydrates the transcript and cursor across terminal surface remounts', async () => {
        const firstMountReadBlocked = createDeferred<{
            ok: true;
            terminalId: string;
            events: [];
            nextCursor: number;
            done: boolean;
        }>();
        const secondMountReadBlocked = createDeferred<{
            ok: true;
            terminalId: string;
            events: [];
            nextCursor: number;
            done: boolean;
        }>();
        try {
            machineTerminalEnsureSpy
                .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false })
                .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });

            machineTerminalStreamReadSpy.mockReset();
            machineTerminalStreamReadSpy
                .mockResolvedValueOnce({
                    ok: true,
                    terminalId: 't1',
                    events: [{ t: 'data', data: 'hello' }],
                    nextCursor: 5,
                    done: false,
                })
                .mockImplementationOnce(() => firstMountReadBlocked.promise)
                .mockResolvedValueOnce({
                    ok: true,
                    terminalId: 't1',
                    events: [],
                    nextCursor: 5,
                    done: false,
                })
                .mockImplementationOnce(() => secondMountReadBlocked.promise);

            const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

            const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);

            expect(terminalHandleInstances[0]?.write).toHaveBeenCalledWith('hello');

            await screen.unmount();
            activeScreen = null;

            firstMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
            await flushHookEffects();

            await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);

            expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(2);
            expect(machineTerminalStreamReadSpy.mock.calls[2]?.[1]?.cursor).toBe(5);
            expect(terminalHandleInstances[1]?.write).toHaveBeenCalledWith('hello');

            secondMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
            await flushHookEffects();
        } finally {
            firstMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
            secondMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
        }
    });

    it('rehydrates cached transcript when the terminal renderer handle changes without remounting the pane hook', async () => {
        const blockedRead = createDeferred<{
            ok: true;
            terminalId: string;
            events: [];
            nextCursor: number;
            done: boolean;
        }>();

        machineTerminalEnsureSpy.mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false });
        machineTerminalStreamReadSpy
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'hello' }],
                nextCursor: 5,
                done: false,
            })
            .mockImplementationOnce(() => blockedRead.promise);

        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        const screen = await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId="session:s1"
                currentDockLocation="details"
                testIdPrefix="pane-a"
            />,
        );

        expect(terminalHandleInstances[0]?.write).toHaveBeenCalledWith('hello');

        terminalRendererVersion = 1;
        await screen.update(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId="session:s1"
                currentDockLocation="details"
                testIdPrefix="pane-b"
            />,
        );

        await flushHookEffects();

        expect(terminalHandleInstances).toHaveLength(2);
        expect(terminalHandleInstances[1]?.clear).toHaveBeenCalledTimes(1);
        expect(terminalHandleInstances[1]?.write).toHaveBeenCalledWith('hello');

        blockedRead.resolve({
            ok: true,
            terminalId: 't1',
            events: [],
            nextCursor: 5,
            done: true,
        });
        await flushHookEffects();
    });

    it('preserves cached transcript when a reused terminal reconnects without a cached terminal id', async () => {
        const cacheMod = await import('@/components/sessions/terminal/terminalSurfaceStateCache');
        cacheMod.replaceTerminalSurfaceState('session:s1:terminal', {
            terminalId: null,
            cursor: 5,
            output: 'hello',
            detectedUrl: null,
        });

        machineTerminalEnsureSpy.mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });
        machineTerminalStreamReadSpy.mockResolvedValueOnce({
            ok: true,
            terminalId: 't1',
            events: [],
            nextCursor: 5,
            done: true,
        });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);
        await flushHookEffects();

        const cached = cacheMod.readTerminalSurfaceState('session:s1:terminal');
        expect(cached).toEqual({
            terminalId: 't1',
            cursor: 5,
            output: 'hello\r\n[Reconnected]\r\n',
            detectedUrl: null,
        });
        expect(terminalHandleInstances[0]?.write).toHaveBeenCalledWith('hello');
        expect(terminalHandleInstances[0]?.write).toHaveBeenCalledWith('\r\n[Reconnected]\r\n');
    });

    it('drops in-flight terminal output that resolves after the user clears the transcript', async () => {
        const delayedRead = createDeferred<{
            ok: true;
            terminalId: string;
            events: Array<{ t: 'data'; data: string }>;
            nextCursor: number;
            done: boolean;
        }>();

        machineTerminalStreamReadSpy.mockReset();
        machineTerminalStreamReadSpy
            .mockImplementationOnce(() => delayedRead.promise)
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId="session:s1" />);
        await vi.waitFor(() => {
            expect(machineTerminalStreamReadSpy).toHaveBeenCalled();
        });

        const clearButton = screen.findByTestId('session-rightpanel-terminal-clear');
        expect(clearButton).toBeTruthy();

        await screen.pressByTestIdAsync('session-rightpanel-terminal-clear');

        await act(async () => {
            delayedRead.resolve({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'stale-output' }],
                nextCursor: 5,
                done: false,
            });
        });
        await flushHookEffects();

        expect(terminalHandleInstances[0]?.clear).toHaveBeenCalled();
        expect(terminalHandleInstances[0]?.write).not.toHaveBeenCalledWith('stale-output');
        expect(machineTerminalStreamReadSpy.mock.calls[1]?.[1]?.cursor).toBe(5);
    });
});

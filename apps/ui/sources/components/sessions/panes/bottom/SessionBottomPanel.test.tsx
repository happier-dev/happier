import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SessionScreenTestIdsProvider } from '../../shell/sessionScreenTestIds';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';
import { publishTerminalSurfaceSummary, forgetTerminalSurfaceSummary } from '@/components/sessions/terminal/terminalSurfaceSummary';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let bottomActiveTabIdMock: string | null = 'terminal';
let terminalWorkspaceMock: unknown = undefined;

installSessionDetailsPanelCommonModuleMocks();

const terminalPaneSpy = vi.fn();
vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: (props: any) => {
        terminalPaneSpy(props);
        return React.createElement('SessionEmbeddedTerminalPane');
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

const closeBottomSpy = vi.fn();
function scopeState() {
    return {
        right: { isOpen: false, activeTabId: null, tabState: {} },
        details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        bottom: { isOpen: true, activeTabId: bottomActiveTabIdMock,
            selectedDestination: bottomActiveTabIdMock ? { kind: 'builtin', id: bottomActiveTabIdMock } : null,
            tabState: { terminal: terminalWorkspaceMock } },
    };
}
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: (scopeId: string) => ({
        scopeId,
        scopeState: scopeState(),
        closeBottom: closeBottomSpy,
        openDetailsTab: vi.fn(),
        openBottom: vi.fn(),
        setBottomTab: vi.fn(),
    }),
}));
vi.mock('@/components/appShell/panes/AppPaneProvider', () => ({
    useAppPaneContext: (select = (value: unknown) => value) => select({ state: { scopes: { 'session:s1': scopeState() } }, dispatch: vi.fn() }),
    useOptionalAppPaneContext: (select = (value: unknown) => value) => select({ state: { scopes: { 'session:s1': scopeState() } }, dispatch: vi.fn() }),
}));

const shell = (id: string, title?: string) => ({ id, target: { kind: 'workspace_shell' }, ...(title ? { title } : {}) });

describe('SessionBottomPanel', () => {
    beforeEach(() => {
        terminalPaneSpy.mockClear();
        closeBottomSpy.mockClear();
        bottomActiveTabIdMock = 'terminal';
        terminalWorkspaceMock = undefined;
    });

    it('draws one strip tab per terminal tab and mounts only the visible tab, without the frame’s own chrome (lab B1)', async () => {
        terminalWorkspaceMock = {
            v: 1,
            tabs: [
                { id: 'embedded', terminals: [shell('embedded')], focusedTerminalId: 'embedded', root: { kind: 'leaf', terminalId: 'embedded' } },
                { id: 'vite', terminals: [shell('vite', 'vite')], focusedTerminalId: 'vite', root: { kind: 'leaf', terminalId: 'vite' } },
            ],
            activeTabId: 'vite',
            showList: false,
        };
        const { SessionBottomPanel } = await import('./SessionBottomPanel');
        const screen = await renderScreen(<SessionBottomPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-bottompanel-terminals-strip-tab-embedded')).toBeTruthy();
        expect(screen.findByTestId('session-bottompanel-terminals-strip-tab-vite')).toBeTruthy();
        expect(new Set(terminalPaneSpy.mock.calls.map((call) => call[0]?.terminal?.id))).toEqual(new Set(['vite']));
        const leaf = terminalPaneSpy.mock.calls[0]?.[0];
        expect(leaf?.chrome).toBe('none');
        expect(leaf?.currentDockLocation).toBe('bottom');
        expect(leaf?.title).toBe('vite');

        leaf?.onRequestClose();
        expect(closeBottomSpy).toHaveBeenCalledTimes(1);
    });

    it('shows both halves of a split tab side by side (lab B2)', async () => {
        terminalWorkspaceMock = {
            v: 1,
            tabs: [{
                id: 'group',
                terminals: [shell('zsh'), shell('vite', 'vite')],
                focusedTerminalId: 'zsh',
                root: { kind: 'split', id: 'split-1', ratio: 0.5, first: { kind: 'leaf', terminalId: 'zsh' }, second: { kind: 'leaf', terminalId: 'vite' } },
            }],
            activeTabId: 'group',
            showList: false,
        };
        const { SessionBottomPanel } = await import('./SessionBottomPanel');
        await renderScreen(<SessionBottomPanel sessionId="s1" scopeId="session:s1" />);

        const mounted = new Set(terminalPaneSpy.mock.calls.map((call) => call[0]?.terminal?.id));
        expect(mounted).toEqual(new Set(['zsh', 'vite']));
        const focused = terminalPaneSpy.mock.calls.filter((call) => call[0]?.focused).map((call) => call[0]?.terminal?.id);
        expect(new Set(focused)).toEqual(new Set(['zsh']));
    });

    it('shows the list view beside the terminal only when the pane is wide enough (lab B3)', async () => {
        terminalWorkspaceMock = {
            v: 1,
            tabs: [{ id: 'embedded', terminals: [shell('embedded')], focusedTerminalId: 'embedded', root: { kind: 'leaf', terminalId: 'embedded' } }],
            activeTabId: 'embedded',
            showList: true,
        };
        const { SessionBottomPanel } = await import('./SessionBottomPanel');
        const screen = await renderScreen(<SessionBottomPanel sessionId="s1" scopeId="session:s1" />);
        const root = screen.findByTestId('session-bottompanel-terminals-root');

        await act(async () => { root?.props.onLayout({ nativeEvent: { layout: { width: 420, height: 300 } } }); });
        expect(screen.findByTestId('session-bottompanel-terminals-list-root')).toBeFalsy();
        expect(screen.findByTestId('session-bottompanel-terminals-strip-tab-embedded')).toBeTruthy();

        await act(async () => { root?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 300 } } }); });
        expect(screen.findByTestId('session-bottompanel-terminals-list-root')).toBeTruthy();
        expect(screen.findByTestId('session-bottompanel-terminals-strip-tab-embedded')).toBeFalsy();
    });

    it('keeps the running address in the list-view strip while a different shell is focused', async () => {
        terminalWorkspaceMock = {
            v: 1,
            tabs: ['embedded', 'vite'].map((id) => ({ id, terminals: [shell(id)], focusedTerminalId: id, root: { kind: 'leaf', terminalId: id } })),
            activeTabId: 'embedded', showList: true,
        };
        const key = 'session:s1:terminal:vite';
        publishTerminalSurfaceSummary(key, { title: null, bell: null, status: 'connected', error: null, failure: null, url: 'http://localhost:5173/' });
        try {
            const { SessionBottomPanel } = await import('./SessionBottomPanel');
            const screen = await renderScreen(<SessionBottomPanel sessionId="s1" scopeId="session:s1" />);
            await act(async () => { screen.findByTestId('session-bottompanel-terminals-root')?.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 300 } } }); });
            expect(screen.findByTestId('session-bottompanel-terminals-strip-live-pill')).toBeTruthy();
        } finally { await act(async () => { forgetTerminalSurfaceSummary(key); }); }
    });

    it('does not render terminal when a different bottom tab is active', async () => {
        bottomActiveTabIdMock = 'files';
        const { SessionBottomPanel } = await import('./SessionBottomPanel');

        await renderScreen(<SessionBottomPanel sessionId="s1" scopeId="session:s1" />);

        expect(terminalPaneSpy).not.toHaveBeenCalled();
    });

    it('suppresses bottom-panel testIDs when the session screen is hidden', async () => {
        const { SessionBottomPanel } = await import('./SessionBottomPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionScreenTestIdsProvider enabled={false}>
                    <SessionBottomPanel sessionId="s1" scopeId="session:s1" />
                </SessionScreenTestIdsProvider>)).tree;

        expect(tree!.findAllByTestId('session-bottom-panel-root')).toHaveLength(0);
        expect(tree!.findAllByTestId('session-bottompanel-surface-terminal')).toHaveLength(0);
        expect(terminalPaneSpy.mock.calls[0]?.[0]?.testIdPrefix).toBeNull();
    });
});

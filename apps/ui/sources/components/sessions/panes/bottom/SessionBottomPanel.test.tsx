import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SessionScreenTestIdsProvider } from '../../shell/sessionScreenTestIds';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let bottomActiveTabIdMock: string | null = 'terminal';

installSessionDetailsPanelCommonModuleMocks();

const terminalPaneSpy = vi.fn();
vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: (props: any) => {
        terminalPaneSpy(props);
        return React.createElement('SessionEmbeddedTerminalPane');
    },
}));

const closeBottomSpy = vi.fn();
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: bottomActiveTabIdMock, tabState: {} },
        },
        closeBottom: closeBottomSpy,
    }),
}));

describe('SessionBottomPanel', () => {
    beforeEach(() => {
        terminalPaneSpy.mockClear();
        closeBottomSpy.mockClear();
        bottomActiveTabIdMock = 'terminal';
    });

    it('renders SessionEmbeddedTerminalPane when the bottom tab is terminal', async () => {
        const { SessionBottomPanel } = await import('./SessionBottomPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionBottomPanel sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree).toBeTruthy();
        expect(terminalPaneSpy).toHaveBeenCalledTimes(1);
        expect(terminalPaneSpy.mock.calls[0]?.[0]?.sessionId).toBe('s1');
        expect(terminalPaneSpy.mock.calls[0]?.[0]?.currentDockLocation).toBe('bottom');

        const onRequestClose = terminalPaneSpy.mock.calls[0]?.[0]?.onRequestClose;
        expect(typeof onRequestClose).toBe('function');
        onRequestClose();
        expect(closeBottomSpy).toHaveBeenCalledTimes(1);
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

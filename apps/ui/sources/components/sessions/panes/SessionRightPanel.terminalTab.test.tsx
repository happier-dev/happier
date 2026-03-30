import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let terminalFeatureEnabled = false;
let embeddedTerminalDockLocation: 'sidebar' | 'details' | 'bottom' = 'sidebar';

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

let scopeState: any = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
};

installSessionDetailsPanelCommonModuleMocks({
    storage: async () => ({
        useLocalSetting: (key: string) => {
            if (key === 'embeddedTerminalDockLocation') return embeddedTerminalDockLocation;
            return null;
        },
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
            translateLoose: (key) => key,
            getPreferredLanguage: () => 'en',
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (fn: any) => fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'terminal.embeddedPty' ? terminalFeatureEnabled : false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: () => React.createElement('FilesView'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitView', () => ({
    SessionRightPanelGitView: () => React.createElement('GitView'),
}));

vi.mock('@/components/sessions/panes/terminal/SessionRightPanelTerminalView', () => ({
    SessionRightPanelTerminalView: () => React.createElement('TerminalView'),
}));

describe('SessionRightPanel (terminal tab)', () => {
    beforeEach(() => {
        terminalFeatureEnabled = false;
        embeddedTerminalDockLocation = 'sidebar';
        scopeState = { right: { isOpen: true, activeTabId: 'git', tabState: {} } };
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        vi.clearAllMocks();
    });

    async function renderPanel() {
        const mod = await import('./SessionRightPanel');
        const SessionRightPanel = mod.SessionRightPanel;
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />)).tree;
        return { tree: tree!, SessionRightPanel };
    }

    it('shows the terminal tab only when the feature is enabled', async () => {
        terminalFeatureEnabled = false;
        const initial = await renderPanel();
        expect(initial.tree.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(0);

        terminalFeatureEnabled = true;
        embeddedTerminalDockLocation = 'bottom';
        const dockedElsewhere = await renderPanel();
        expect(dockedElsewhere.tree.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(0);

        embeddedTerminalDockLocation = 'sidebar';
        const enabled = await renderPanel();
        expect(enabled.tree.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(1);
    });
});

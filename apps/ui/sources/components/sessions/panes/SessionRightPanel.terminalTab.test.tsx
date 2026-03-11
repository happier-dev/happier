import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let terminalFeatureEnabled = false;
let embeddedTerminalDockLocation: 'sidebar' | 'details' | 'bottom' = 'sidebar';

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

let scopeState: any = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
};

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    AppState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
    },
    Platform: { select: () => 1 },
}));

const themeColors = {
    text: '#fff',
    textSecondary: '#aaa',
    textLink: '#00f',
    surface: '#000',
    surfaceHigh: '#111',
    divider: '#222',
    border: '#222',
    indigo: '#5856D6',
    accent: {
        blue: '#007AFF',
        green: '#34C759',
        orange: '#FF9500',
        yellow: '#FFCC00',
        red: '#FF3B30',
        indigo: '#5856D6',
        purple: '#AF52DE',
    },
    modal: { border: '#222' },
    input: { background: '#111' },
    header: { tint: '#fff' },
    status: { error: '#f00' },
    shadow: { color: '#000', opacity: 0.2 },
    groupped: { background: '#111', chevron: '#222', sectionTitle: '#aaa' },
};

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) =>
            typeof styles === 'function'
                ? styles({ colors: themeColors }, {})
                : styles,
    },
    useUnistyles: () => ({ theme: { colors: themeColors } }),
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'embeddedTerminalDockLocation') return embeddedTerminalDockLocation;
        return null;
    },
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
        await act(async () => {
            tree = renderer.create(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);
        });
        return { tree: tree!, SessionRightPanel };
    }

    it('shows the terminal tab only when the feature is enabled', async () => {
        terminalFeatureEnabled = false;
        const initial = await renderPanel();
        expect(initial.tree.root.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(0);

        terminalFeatureEnabled = true;
        embeddedTerminalDockLocation = 'bottom';
        const dockedElsewhere = await renderPanel();
        expect(dockedElsewhere.tree.root.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(0);

        embeddedTerminalDockLocation = 'sidebar';
        const enabled = await renderPanel();
        expect(enabled.tree.root.findAll((node) => node.props?.testID === 'session-rightpanel-tab:terminal')).toHaveLength(1);
    });
});

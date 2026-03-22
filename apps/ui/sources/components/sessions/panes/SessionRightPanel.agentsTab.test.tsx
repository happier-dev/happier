import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let terminalFeatureEnabled = false;

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

let scopeState: any = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                            View: 'View',
                                                            Pressable: 'Pressable',
                                                            ActivityIndicator: 'ActivityIndicator',
                                                            AppState: {
                                                            currentState: 'active',
                                                            addEventListener: () => ({ remove: () => {} }),
                                                        },
                                                            Platform: {
                                                            select: () => 1,
                                                        },
                                                        }
    );
});

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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (fn: any) => fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'terminal.embeddedPty' ? terminalFeatureEnabled : false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useLocalSetting: () => 'sidebar',
});
});

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

vi.mock('@/components/sessions/panes/agents/SessionRightPanelAgentsView', () => ({
    SessionRightPanelAgentsView: () => React.createElement('AgentsView'),
}));

vi.mock('@/components/sessions/panes/terminal/SessionRightPanelTerminalView', () => ({
    SessionRightPanelTerminalView: () => React.createElement('TerminalView'),
}));

function findHostByTestId(screen: RenderScreenResult, testID: string) {
    return screen.findAllByTestId(testID).find((node) => typeof node.type === 'string') ?? null;
}

function getStyleValue(style: unknown, key: string): unknown {
    const styles = Array.isArray(style) ? style : [style];
    for (const entry of styles) {
        if (entry && typeof entry === 'object' && key in entry) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}

describe('SessionRightPanel (core tabs)', () => {
    beforeEach(() => {
        terminalFeatureEnabled = false;
        scopeState = { right: { isOpen: true, activeTabId: 'git', tabState: {} } };
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        vi.clearAllMocks();
    });

    it('renders git, files, and agents tabs and shows the git surface by default', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-rightpanel-tab:git')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:files')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:agents')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:terminal')).toBeNull();

        expect(getStyleValue(findHostByTestId(screen, 'session-rightpanel-surface-git')?.props.style, 'visibility')).toBe('visible');
        expect(findHostByTestId(screen, 'session-rightpanel-surface-files')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-agents')).toBeNull();
    });

    it('keeps a single agents surface test id when the agents tab is active', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'agents', tabState: {} } };
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(getStyleValue(findHostByTestId(screen, 'session-rightpanel-surface-agents')?.props.style, 'visibility')).toBe('visible');
        expect(findHostByTestId(screen, 'session-rightpanel-surface-git')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-files')).toBeNull();
    });
});

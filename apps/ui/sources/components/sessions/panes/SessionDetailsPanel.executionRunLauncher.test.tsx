import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: { create: (value: any) => value },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'editorFocusModeEnabled') return false;
        return null;
    },
    useLocalSettingMutable: () => [false, vi.fn()],
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'execution-run-launcher:review',
                tabState: {},
                tabs: [
                    {
                        key: 'execution-run-launcher:review',
                        kind: 'executionRunLauncher',
                        title: 'Review run',
                        isPinned: false,
                        isPreview: true,
                        resource: { kind: 'executionRunLauncher', intent: 'review' },
                    },
                ],
            },
        },
    }),
}));

const launcherViewSpy = vi.fn();
let SessionDetailsPanel: typeof import('./SessionDetailsPanel').SessionDetailsPanel;

vi.mock('@/components/sessions/runs/launcher/SessionExecutionRunLauncherView', () => ({
    SessionExecutionRunLauncherView: (props: any) => {
        launcherViewSpy(props);
        return React.createElement('SessionExecutionRunLauncherView');
    },
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

describe('SessionDetailsPanel (execution run launcher resource)', () => {
    beforeAll(async () => {
        ({ SessionDetailsPanel } = await import('./SessionDetailsPanel'));
    }, 60_000);

    it('renders SessionExecutionRunLauncherView for execution run launcher tabs', async () => {
        launcherViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree).toBeTruthy();
        expect(launcherViewSpy).toHaveBeenCalledTimes(1);
        expect(launcherViewSpy.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 's1',
            scopeId: 'session:s1',
            presentation: 'panel',
            initialIntent: 'review',
        });
    });

    it('renders execution-run launcher tabs without an intermediate loading fallback', () => {
        launcherViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree).toBeTruthy();
        expect(tree!.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(launcherViewSpy).toHaveBeenCalledTimes(1);
    });
});

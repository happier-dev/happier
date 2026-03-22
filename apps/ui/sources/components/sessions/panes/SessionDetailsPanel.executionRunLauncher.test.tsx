import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useLocalSetting: ((key: string) => {
                if (key === 'editorFocusModeEnabled') return false;
                return null;
            }) as any,
            useLocalSettingMutable: (() => [false, vi.fn()]) as any,
        },
    });
});

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
    const getSessionDetailsPanel = async () => (await import('./SessionDetailsPanel')).SessionDetailsPanel;

    it('renders SessionExecutionRunLauncherView for execution run launcher tabs', async () => {
        launcherViewSpy.mockClear();

        const SessionDetailsPanel = await getSessionDetailsPanel();
        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(launcherViewSpy).toHaveBeenCalledTimes(1);
        expect(launcherViewSpy.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 's1',
            scopeId: 'session:s1',
            presentation: 'panel',
            initialIntent: 'review',
        });
        expect(screen.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('renders execution-run launcher tabs without an intermediate loading fallback', async () => {
        launcherViewSpy.mockClear();

        const SessionDetailsPanel = await getSessionDetailsPanel();
        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(launcherViewSpy).toHaveBeenCalledTimes(1);
    });
});

import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SessionDetailsPanel } from './SessionDetailsPanel';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                            Platform: {
                                                            OS: 'web',
                                                            select: (_: any) => 1,
                                                        },
                                                            AppState: {
                                                            currentState: 'active',
                                                            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
                                                        },
                                                            ActivityIndicator: 'ActivityIndicator',
                                                            View: 'View',
                                                            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                                                            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
                                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#000',
                textSecondary: '#666',
                accent: { indigo: '#00f' },
                shadow: { color: '#000' },
            },
        },
    });
});

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

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
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

const scopeState = {
    details: {
        isOpen: true,
        activeTabKey: null,
        tabs: [
            { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
            { key: 'file:b', kind: 'file', title: 'b.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'b.txt' } },
        ],
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState,
    }),
}));

describe('SessionDetailsPanel (active tab fallback)', () => {
    it('marks only the last tab active when activeTabKey is missing', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />)).tree;

        const tabButtons = tree!.root
            .findAllByType('Pressable')
            .filter((node: any) => node.props?.accessibilityLabel === 'session.detailsPanel.openTabA11y');
        expect(tabButtons).toHaveLength(2);

        const firstStyles = tabButtons[0]!.props.style;
        const secondStyles = tabButtons[1]!.props.style;

        const hasSurfaceHighBg = (styleProp: any) =>
            Array.isArray(styleProp) && styleProp.some((s: any) => s && s.backgroundColor === '#f5f5f5');
        expect(hasSurfaceHighBg(firstStyles)).toBe(false);
        expect(hasSurfaceHighBg(secondStyles)).toBe(true);
    });
});

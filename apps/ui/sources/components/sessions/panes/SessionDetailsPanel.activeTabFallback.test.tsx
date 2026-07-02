import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const detailsPanelTheme = createThemeFixture() as Readonly<{
    colors: {
        surface: {
            inset: string;
        };
    };
}>;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: detailsPanelTheme,
        });
    },
    icons: async () => ({
        Octicons: 'Octicons',
        Ionicons: 'Ionicons',
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting: ((key: string) => {
                    return null;
                }) as any,
                useLocalSettingMutable: (() => [false, vi.fn()]) as any,
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}), eyebrow: () => ({}), keyHint: () => ({}) },
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
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        const firstTab = screen.findByTestId('session-details-tab-file_a');
        const secondTab = screen.findByTestId('session-details-tab-file_b');
        expect(firstTab).toBeTruthy();
        expect(secondTab).toBeTruthy();

        const firstStyles = firstTab?.props.style;
        const secondStyles = secondTab?.props.style;

        const hasInsetBg = (styleProp: any) =>
            Array.isArray(styleProp)
            && styleProp.some((s: any) => s && s.backgroundColor === detailsPanelTheme.colors.surface.inset);
        expect(hasInsetBg(firstStyles)).toBe(false);
        expect(hasInsetBg(secondStyles)).toBe(true);
    });
});

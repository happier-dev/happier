import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#fff',
                    surfaceHigh: '#f5f5f5',
                    divider: '#eee',
                    text: '#000',
                    textSecondary: '#666',
                    shadow: { color: '#000', opacity: 0.2 },
                    accent: {
                        indigo: '#5C6BC0',
                        orange: '#FF9500',
                    },
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async (importOriginal) => {
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
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

let mockAppPaneScope: any = null;
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => mockAppPaneScope,
}));

describe('SessionDetailsPanel (close tab)', () => {
    it('closes a tab exactly once when clicking its close button', async () => {
        const closeDetailsTabSpy = vi.fn();

        mockAppPaneScope = {
            closeDetails: vi.fn(),
            closeDetailsTab: closeDetailsTabSpy,
            pinDetailsTab: vi.fn(),
            setActiveDetailsTab: vi.fn(),
            scopeState: {
                details: {
                    isOpen: true,
                    activeTabKey: 'file:a',
                    tabs: [
                        { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
                    ],
                },
            },
        };

        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        await screen.pressByTestIdAsync('session-details-tab-close-file_a');

        expect(closeDetailsTabSpy).toHaveBeenCalledTimes(1);
        expect(closeDetailsTabSpy).toHaveBeenCalledWith('file:a');
    });
});

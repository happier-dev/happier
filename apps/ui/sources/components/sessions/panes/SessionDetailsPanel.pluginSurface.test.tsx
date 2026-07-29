import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pluginUiProjection = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    surfacePlacementsByPlacement: {
        'session.preview': [{
            id: 'sessionSurface:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'preview-pane',
            placement: 'session.preview',
            target: { kind: 'session', sessionIdPath: '/session/id' },
            renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
            display: { titleKey: 'title' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        }],
    },
};

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
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => null,
            useLocalSettingMutable: () => [false, vi.fn()],
            useEndpointStatus: () => 'online',
            useMachineCliDetectionTarget: () => ({
                isOnline: true,
                daemonStateVersion: 1,
            }),
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
        eyebrow: () => ({}),
        keyHint: () => ({}),
        rowTitle: () => ({}),
        rowMeta: () => ({}),
        pillLabel: () => ({}),
    },
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'plugin:preview',
                tabs: [
                    {
                        key: 'plugin:preview',
                        kind: 'pluginSessionSurface',
                        title: 'Preview',
                        isPinned: true,
                        isPreview: false,
                        resource: {
                            kind: 'pluginSessionSurface',
                            surfaceId: 'sessionSurface:acme.preview:preview-pane',
                        },
                    },
                ],
            },
        },
    }),
}));

describe('SessionDetailsPanel plugin session surfaces', () => {
    it('renders descriptor-backed plugin session surface tabs through host-owned fallback renderers', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        const screen = await renderScreen(<SessionDetailsPanel
            sessionId="s1"
            scopeId="session:s1"
            {...({ pluginUiProjection } as any)}
        />);
        await flushHookEffects({ cycles: 8, turns: 3 });

        expect(screen.findByTestId('plugin-session-surface-previewPlaceholder')).toBeTruthy();
    });
});

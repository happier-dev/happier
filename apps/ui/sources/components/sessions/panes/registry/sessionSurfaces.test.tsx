import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('TextInput', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('plugin session surface registry', () => {
    it('routes simulator preview resources through the simulator session pane', async () => {
        const { renderSessionSurfaceTab } = await import('./sessionSurfaces');
        const node = renderSessionSurfaceTab({
            sessionId: 'session_1',
            tab: {
                key: 'simulator:preview',
                kind: 'simulatorPreview',
                title: 'Simulator',
                isPinned: true,
                isPreview: false,
                resource: {
                    kind: 'simulatorPreview',
                    viewerId: 'viewer_1',
                },
            },
        } as never);

        const screen = await renderScreen(<>{node}</>);

        expect(screen.findByTestId('session-simulator:session_1')).toBeTruthy();
        expect(screen.findByTestId('session-simulator:session_1-preview-picker-empty')).toBeTruthy();
    });

    it('does not admit the unshipped pluginSessionSurface resource into Details rendering', async () => {
        const { renderSessionSurfaceTab } = await import('./sessionSurfaces');

        expect(renderSessionSurfaceTab({
            sessionId: 'session_1',
            tab: {
                key: 'plugin:preview',
                kind: 'pluginSessionSurface',
                title: 'Preview',
                isPinned: true,
                isPreview: false,
                resource: {
                    kind: 'pluginSessionSurface',
                    destination: { pluginId: 'acme.preview', localId: 'preview-pane' },
                },
            } as never,
        })).toBeNull();
    });
});

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

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

// Compile the real runtime graph during collection, outside the interaction deadline.
const { renderSessionSurfaceTab } = await import('./sessionSurfaces');

describe('plugin session surface registry', () => {
    it('routes simulator preview resources through the simulator session pane', async () => {
        const node = renderSessionSurfaceTab({
            sessionId: 'session_1',
            simulatorPreview: null,
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
});

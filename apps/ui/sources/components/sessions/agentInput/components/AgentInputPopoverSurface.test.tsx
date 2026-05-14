import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFloatingOverlayProps: Record<string, unknown> | null = null;

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#fff',
                    modal: { border: '#eee' },
                    shadow: { color: '#000', opacity: 0.2 },
                },
            },
        });
    },
});

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capturedFloatingOverlayProps = props;
        return React.createElement('FloatingOverlay', props, props.children);
    },
}));

import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';

describe('AgentInputPopoverSurface', () => {
    it('applies the shared surface contract when scroll is disabled', async () => {
        capturedFloatingOverlayProps = null;

        const screen = await renderScreen(
            <AgentInputPopoverSurface maxHeight={123} scrollEnabled={false}>
                <Child />
            </AgentInputPopoverSurface>,
        );

        expect(screen.findByType('FloatingOverlay')).not.toBeNull();
        expect(capturedFloatingOverlayProps).toEqual(expect.objectContaining({
            maxHeight: 123,
            scrollEnabled: false,
            surfaceChrome: 'theme',
        }));
    });
});

function Child() {
    return React.createElement('Child');
}

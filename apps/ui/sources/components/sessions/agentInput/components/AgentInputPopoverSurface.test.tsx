import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFloatingOverlayProps: Record<string, unknown> | null = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Platform: {
                                    OS: 'web',
                                },
                                    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('View', props, props.children),
                                }
    );
});

vi.mock('react-native-unistyles', async () => {
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
});

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capturedFloatingOverlayProps = props;
        return React.createElement('FloatingOverlay', props, props.children);
    },
}));

import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';
import { renderScreen } from '@/dev/testkit';


describe('AgentInputPopoverSurface', () => {
    it('applies the shared surface contract when scroll is disabled', async () => {
        capturedFloatingOverlayProps = null;

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<AgentInputPopoverSurface maxHeight={123} scrollEnabled={false}>
                    <Child />
                </AgentInputPopoverSurface>)).tree;

        expect(tree!.root.findAllByType('FloatingOverlay')).toHaveLength(1);
        expect(capturedFloatingOverlayProps).toEqual(expect.objectContaining({
            maxHeight: 123,
            scrollEnabled: false,
        }));
    });
});

function Child() {
    return React.createElement('Child');
}

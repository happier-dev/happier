import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedAnimatedSpies = vi.hoisted(() => ({
    loopSpy: vi.fn((anim: any) => anim),
    sequenceSpy: vi.fn((xs: any[]) => ({ start: vi.fn(), stop: vi.fn(), _xs: xs })),
    timingSpy: vi.fn(() => ({ start: (cb?: any) => cb?.({ finished: true }) })),
}));

installTranscriptMotionCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            Animated: {
                Value: class {
                    constructor(_v: any) {}
                },
                timing: hoistedAnimatedSpies.timingSpy,
                sequence: hoistedAnimatedSpies.sequenceSpy,
                loop: hoistedAnimatedSpies.loopSpy,
                View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
            },
            Easing: {
                quad: (t: number) => t,
                bezier: () => (t: number) => t,
                inOut: (fn: any) => fn,
                linear: (t: number) => t,
            },
        });
    },
});

describe('ThinkingPulseLabel', () => {
    it('renders plain text when disabled', async () => {
        const { ThinkingPulseLabel } = await import('./ThinkingPulseLabel');
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ThinkingPulseLabel label="Thinking…" enabled={false} />)).tree;
        expect(tree!.findAllByType('AnimatedView' as any)).toHaveLength(0);
        expect(tree!.findByType('Text' as any).props.children).toBe('Thinking…');
    });

    it('starts a loop when enabled', async () => {
        const { ThinkingPulseLabel } = await import('./ThinkingPulseLabel');
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ThinkingPulseLabel label="Thinking…" enabled={true} />)).tree;
        expect(tree!.findAllByType('AnimatedView' as any)).toHaveLength(1);
        expect(hoistedAnimatedSpies.loopSpy).toHaveBeenCalledTimes(1);
        expect(hoistedAnimatedSpies.sequenceSpy).toHaveBeenCalledTimes(1);
        expect(hoistedAnimatedSpies.timingSpy).toHaveBeenCalled();
    });
});

import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loopSpy = vi.fn((anim: any) => anim);
const sequenceSpy = vi.fn((xs: any[]) => ({ start: vi.fn(), stop: vi.fn(), _xs: xs }));
const timingSpy = vi.fn(() => ({ start: (cb?: any) => cb?.({ finished: true }) }));

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...(stub as any).Platform, OS: 'web' },
        Animated: {
            ...(stub as any).Animated,
            Value: class {
                constructor(_v: any) { }
            },
            timing: timingSpy,
            sequence: sequenceSpy,
            loop: loopSpy,
            View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
        },
        Easing: {
            ...(stub as any).Easing,
            quad: (t: number) => t,
            bezier: () => (t: number) => t,
            inOut: (fn: any) => fn,
            linear: (t: number) => t,
        },
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('ThinkingPulseLabel', () => {
    it('renders plain text when disabled', async () => {
        const { ThinkingPulseLabel } = await import('./ThinkingPulseLabel');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ThinkingPulseLabel label="Thinking…" enabled={false} />);
        });
        expect(tree!.root.findAllByType('AnimatedView' as any)).toHaveLength(0);
        expect(tree!.root.findByType('Text' as any).props.children).toBe('Thinking…');
    });

    it('starts a loop when enabled', async () => {
        const { ThinkingPulseLabel } = await import('./ThinkingPulseLabel');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ThinkingPulseLabel label="Thinking…" enabled={true} />);
        });
        expect(tree!.root.findAllByType('AnimatedView' as any)).toHaveLength(1);
        expect(loopSpy).toHaveBeenCalledTimes(1);
        expect(sequenceSpy).toHaveBeenCalledTimes(1);
        expect(timingSpy).toHaveBeenCalled();
    });
});

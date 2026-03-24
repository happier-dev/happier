import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { TranscriptMotionContext } from './TranscriptMotionContext';
import { installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedAnimatedSpies = vi.hoisted(() => ({
    timingSpy: vi.fn(() => ({ start: (cb?: any) => cb?.({ finished: true }) })),
}));

installTranscriptMotionCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Animated: {
                Value: class {
                    constructor(_v: any) {}
                    setValue(_v: any) {}
                    interpolate(_cfg: any) {
                        return 0;
                    }
                },
                timing: hoistedAnimatedSpies.timingSpy,
                View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
            },
            Easing: {
                bezier: () => (t: number) => t,
                linear: (t: number) => t,
            },
        });
    },
});

describe('TranscriptCollapsible', () => {
    it('animates expand when enabled and fresh-only allows', async () => {
        const gate = { consumeFreshness: vi.fn(() => true), markSeen: vi.fn(), isSeen: vi.fn() };
        const runtime: any = {
            gate,
            config: {
                preset: 'subtle',
                freshnessMs: 60_000,
                animateNewItemsEnabled: true,
                animateToolExpandCollapseEnabled: true,
                animateToolExpandCollapseFreshOnly: true,
                animateThinkingEnabled: true,
            },
        };

        const { TranscriptCollapsible } = await import('./TranscriptCollapsible');

        const { renderScreen } = await import('@/dev/testkit');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id="t1" createdAt={1} expanded={false}>
                        <div />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>)).tree;

        hoistedAnimatedSpies.timingSpy.mockClear();
        await act(async () => {
            tree!.update(
                <TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id="t1" createdAt={1} expanded={true}>
                        <div />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>
            );
        });

        expect(gate.consumeFreshness).toHaveBeenCalledTimes(1);
        expect(hoistedAnimatedSpies.timingSpy).toHaveBeenCalledTimes(1);
    });

    it('does not animate when fresh-only gate rejects', async () => {
        const gate = { consumeFreshness: vi.fn(() => false), markSeen: vi.fn(), isSeen: vi.fn() };
        const runtime: any = {
            gate,
            config: {
                preset: 'subtle',
                freshnessMs: 60_000,
                animateNewItemsEnabled: true,
                animateToolExpandCollapseEnabled: true,
                animateToolExpandCollapseFreshOnly: true,
                animateThinkingEnabled: true,
            },
        };

        const { TranscriptCollapsible } = await import('./TranscriptCollapsible');

        const { renderScreen } = await import('@/dev/testkit');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id="t1" createdAt={1} expanded={false}>
                        <div />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>)).tree;

        hoistedAnimatedSpies.timingSpy.mockClear();
        await act(async () => {
            tree!.update(
                <TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id="t1" createdAt={1} expanded={true}>
                        <div />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>
            );
        });

        expect(gate.consumeFreshness).toHaveBeenCalledTimes(1);
        expect(hoistedAnimatedSpies.timingSpy).toHaveBeenCalledTimes(0);
    });
});

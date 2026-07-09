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
    it('announces row layout mutation before mounting expanded children', async () => {
        const runtime: any = null;
        const events: string[] = [];

        const { TranscriptCollapsible } = await import('./TranscriptCollapsible');
        const { TranscriptRowLayoutMutationProvider } = await import('../measurement/TranscriptRowLayoutMutationContext');
        const { renderScreen } = await import('@/dev/testkit');

        function Child() {
            events.push('child-render');
            return React.createElement('div');
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(
            <TranscriptRowLayoutMutationProvider
                value={(mutation) => {
                    events.push(`mutation:${mutation.reason}:${mutation.sourceId}`);
                }}
            >
                <TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id="t1" createdAt={1} expanded={false}>
                        <Child />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>
            </TranscriptRowLayoutMutationProvider>
        )).tree;

        expect(events).toEqual([]);

        await act(async () => {
            tree!.update(
                <TranscriptRowLayoutMutationProvider
                    value={(mutation) => {
                        events.push(`mutation:${mutation.reason}:${mutation.sourceId}`);
                    }}
                >
                    <TranscriptMotionContext.Provider value={runtime}>
                        <TranscriptCollapsible id="t1" createdAt={1} expanded={true}>
                            <Child />
                        </TranscriptCollapsible>
                    </TranscriptMotionContext.Provider>
                </TranscriptRowLayoutMutationProvider>
            );
        });

        expect(events).toEqual(['mutation:expand:t1', 'child-render']);
    });

    it('announces row layout mutation before collapsing mounted children', async () => {
        const runtime: any = {
            gate: { consumeFreshness: vi.fn(() => true), markSeen: vi.fn(), isSeen: vi.fn() },
            config: {
                preset: 'subtle',
                freshnessMs: 60_000,
                animateNewItemsEnabled: true,
                animateToolExpandCollapseEnabled: true,
                animateToolExpandCollapseFreshOnly: false,
                animateThinkingEnabled: true,
            },
        };
        const events: string[] = [];

        const { TranscriptCollapsible } = await import('./TranscriptCollapsible');
        const { TranscriptRowLayoutMutationProvider } = await import('../measurement/TranscriptRowLayoutMutationContext');
        const { renderScreen } = await import('@/dev/testkit');

        function Child() {
            events.push('child-render');
            return React.createElement('div');
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(
            <TranscriptRowLayoutMutationProvider
                value={(mutation) => {
                    events.push(`mutation:${mutation.reason}:${mutation.sourceId}`);
                }}
            >
                <TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id="t1" createdAt={1} expanded={true}>
                        <Child />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>
            </TranscriptRowLayoutMutationProvider>
        )).tree;

        expect(events).toEqual(['child-render']);
        events.length = 0;

        await act(async () => {
            tree!.update(
                <TranscriptRowLayoutMutationProvider
                    value={(mutation) => {
                        events.push(`mutation:${mutation.reason}:${mutation.sourceId}`);
                    }}
                >
                    <TranscriptMotionContext.Provider value={runtime}>
                        <TranscriptCollapsible id="t1" createdAt={1} expanded={false}>
                            <Child />
                        </TranscriptCollapsible>
                    </TranscriptMotionContext.Provider>
                </TranscriptRowLayoutMutationProvider>
            );
        });

        expect(events).toContain('mutation:collapse:t1');
    });

    it('does not announce a layout mutation when only the provider callback identity changes', async () => {
        const runtime: any = null;
        const events: string[] = [];

        const { TranscriptCollapsible } = await import('./TranscriptCollapsible');
        const { TranscriptRowLayoutMutationProvider } = await import('../measurement/TranscriptRowLayoutMutationContext');
        const { renderScreen } = await import('@/dev/testkit');

        const renderTree = (providerVersion: number) => (
            <TranscriptRowLayoutMutationProvider
                value={(mutation) => {
                    events.push(`v${providerVersion}:${mutation.reason}:${mutation.sourceId}`);
                }}
            >
                <TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id="t1" createdAt={1} expanded={true}>
                        <div />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>
            </TranscriptRowLayoutMutationProvider>
        );

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(renderTree(1))).tree;

        expect(events).toEqual([]);

        await act(async () => {
            tree!.update(renderTree(2));
        });

        expect(events).toEqual([]);
    });

    it('does not treat recycled row identity as an expand/collapse transition', async () => {
        const runtime: any = null;
        const events: string[] = [];

        const { TranscriptCollapsible } = await import('./TranscriptCollapsible');
        const { TranscriptRowLayoutMutationProvider } = await import('../measurement/TranscriptRowLayoutMutationContext');
        const { renderScreen } = await import('@/dev/testkit');

        const renderTree = (id: string) => (
            <TranscriptRowLayoutMutationProvider
                value={(mutation) => {
                    events.push(`${mutation.reason}:${mutation.sourceId}`);
                }}
            >
                <TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptCollapsible id={id} createdAt={1} expanded={true}>
                        <div />
                    </TranscriptCollapsible>
                </TranscriptMotionContext.Provider>
            </TranscriptRowLayoutMutationProvider>
        );

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(renderTree('t1'))).tree;

        hoistedAnimatedSpies.timingSpy.mockClear();
        expect(events).toEqual([]);

        await act(async () => {
            tree!.update(renderTree('t2'));
        });

        expect(events).toEqual([]);
        expect(hoistedAnimatedSpies.timingSpy).not.toHaveBeenCalled();
    });

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

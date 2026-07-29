// @vitest-environment node

import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react';

type Row = Readonly<{ id: string }>;

function createLegendNodeMock(
    element: React.ReactElement,
    onPhysicalScroll: () => void = () => {},
): Record<string, unknown> {
    const { className: classNameProp } = element.props as Readonly<{ className?: unknown }>;
    const className = String(classNameProp ?? '');
    return {
        addEventListener: vi.fn(),
        clientHeight: 600,
        clientWidth: 800,
        getBoundingClientRect: () => ({
            bottom: 600,
            height: 600,
            left: 0,
            right: 800,
            top: 0,
            width: 800,
            x: 0,
            y: 0,
        }),
        querySelector: vi.fn(),
        removeEventListener: vi.fn(),
        scrollBy: vi.fn(),
        scrollHeight: className.includes('legend-list-container') ? 2_400 : 600,
        scrollLeft: 0,
        scrollTo: vi.fn(onPhysicalScroll),
        scrollTop: 0,
        scrollWidth: 800,
        style: {},
    };
}

describe('Legend installed React-export cleanup', () => {
    let screen: ReactTestRenderer | null = null;
    let didUnmount = false;
    let readinessCallbacksAfterUnmount = 0;

    beforeEach(() => {
        vi.useFakeTimers();
        didUnmount = false;
        readinessCallbacksAfterUnmount = 0;
        vi.stubGlobal('ResizeObserver', class {
            observe() {}
            unobserve() {}
            disconnect() {}
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => {
                if (didUnmount) {
                    readinessCallbacksAfterUnmount += 1;
                }
                callback(Date.now());
            }, 16) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    });

    afterEach(() => {
        if (screen) {
            didUnmount = true;
            act(() => screen?.unmount());
            screen = null;
        }
        vi.clearAllTimers();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('settles and cancels a not-ready imperative request on unmount without post-unmount work', async () => {
        const listRef = React.createRef<LegendListRef>();

        await act(async () => {
            screen = create(
                <LegendList
                    data={Array.from({ length: 10 }, (_value, index) => ({ id: `row-${index}` }))}
                    estimatedItemSize={240}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                {
                    createNodeMock(element: React.ReactElement) {
                        return createLegendNodeMock(element);
                    },
                },
            );
        });
        await vi.runAllTimersAsync();
        expect(vi.getTimerCount()).toBe(0);

        let settled = false;
        let result: Promise<void> | undefined;
        act(() => {
            result = listRef.current?.scrollToIndex({ animated: false, index: 99 });
        });
        void result?.then(() => {
            settled = true;
        });
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        didUnmount = true;
        act(() => screen?.unmount());
        screen = null;
        await Promise.resolve();
        const timersAfterUnmount = vi.getTimerCount();
        await vi.runAllTimersAsync();

        expect({
            readinessCallbacksAfterUnmount,
            settled,
            timersAfterUnmount,
        }).toEqual({
            readinessCallbacksAfterUnmount: 0,
            settled: true,
            timersAfterUnmount: 0,
        });
    });

    it('operation-binds overlapping nonanimated completions through the React export', async () => {
        const listRef = React.createRef<LegendListRef>();
        let firstSettled = false;
        let secondSettled = false;
        let physicalWrites = 0;

        await act(async () => {
            screen = create(
                <LegendList
                    data={Array.from({ length: 40 }, (_value, index) => ({ id: `overlap-row-${index}` }))}
                    estimatedItemSize={240}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                {
                    createNodeMock(element: React.ReactElement) {
                        return createLegendNodeMock(element, () => {
                            physicalWrites += 1;
                        });
                    },
                },
            );
        });
        await vi.runAllTimersAsync();
        physicalWrites = 0;
        vi.stubGlobal('requestAnimationFrame', () => 0);
        vi.stubGlobal('cancelAnimationFrame', () => {});

        let firstResult!: Promise<void>;
        act(() => {
            firstResult = listRef.current!.scrollToIndex({
                animated: false,
                index: 4,
                viewPosition: 0,
            });
        });
        void firstResult.then(() => {
            firstSettled = true;
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(40);
        });
        expect(firstSettled).toBe(false);

        let secondResult!: Promise<void>;
        act(() => {
            secondResult = listRef.current!.scrollToIndex({
                animated: false,
                index: 32,
                viewPosition: 0,
            });
        });
        void secondResult.then(() => {
            secondSettled = true;
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect({
            firstSettled,
            physicalWrites,
            secondSettled,
        }).toEqual({
            firstSettled: true,
            physicalWrites: 2,
            secondSettled: false,
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60);
        });
        expect(secondSettled).toBe(false);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(40);
        });
        expect(secondSettled).toBe(true);
    });
});

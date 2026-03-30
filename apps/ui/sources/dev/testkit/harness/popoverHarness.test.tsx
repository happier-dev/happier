import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

type FrameScheduler = (callback: FrameRequestCallback) => number;

function getFrameScheduler(): FrameScheduler | undefined {
    return Reflect.get(globalThis, 'requestAnimation' + 'Frame') as FrameScheduler | undefined;
}

describe('popoverHarness', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('installs immediate web globals for Popover tests and restores the previous values afterward', async () => {
        const harnessModule = await import('./popoverHarness');
        const withPopoverWebGlobals = Reflect.get(harnessModule, 'withPopoverWebGlobals');

        expect(typeof withPopoverWebGlobals).toBe('function');

        if (typeof withPopoverWebGlobals !== 'function') {
            return;
        }

        const previousWindow = { previous: true };
        const previousFrameScheduler: FrameScheduler = vi.fn(() => 9);
        vi.stubGlobal('window', previousWindow);
        vi.stubGlobal('requestAnimation' + 'Frame', previousFrameScheduler);

        const callback = vi.fn();
        let scheduledFrame: FrameRequestCallback | null = null;
        const frameScheduler: FrameScheduler = (scheduledCallback) => {
            scheduledFrame = scheduledCallback;
            return 17;
        };

        await withPopoverWebGlobals(async () => {
            expect(globalThis.window).not.toBe(previousWindow);
            expect(typeof globalThis.window.addEventListener).toBe('function');
            expect(typeof globalThis.window.removeEventListener).toBe('function');

            const frameId = getFrameScheduler()?.(callback);
            expect(frameId).toBe(17);
            expect(callback).not.toHaveBeenCalled();
            const runScheduledFrame =
                scheduledFrame ??
                ((_timestamp: number) => {
                    throw new Error('Expected custom frame scheduler to capture the callback');
                });
            runScheduledFrame(0);
            expect(callback).toHaveBeenCalledTimes(1);
        }, { frameScheduler });

        expect(globalThis.window).toBe(previousWindow);
        expect(getFrameScheduler()).toBe(previousFrameScheduler);
    });

    it('returns the first host node matching a testID when wrappers and host nodes share the same props', async () => {
        const harnessModule = await import('./popoverHarness');
        const findFirstHostNodeByTestId = Reflect.get(harnessModule, 'findFirstHostNodeByTestId');

        expect(typeof findFirstHostNodeByTestId).toBe('function');

        if (typeof findFirstHostNodeByTestId !== 'function') {
            return;
        }

        const Wrapper = (props: { testID: string }) => React.createElement('View', props);
        const screen = await renderScreen(React.createElement(Wrapper, { testID: 'popover-anchor-overlay' }));

        const host = findFirstHostNodeByTestId(screen.tree, 'popover-anchor-overlay');
        expect(host).not.toBeNull();
        expect(host?.type).toBe('View');
    });
});

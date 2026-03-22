import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('popoverHarness', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('installs immediate web globals for Popover tests and restores the previous values afterward', async () => {
        const harnessModule = await import('./popoverHarness');
        const withPopoverWebGlobals = Reflect.get(harnessModule, 'withPopoverWebGlobals');

        expect(typeof withPopoverWebGlobals).toBe('function');

        if (typeof withPopoverWebGlobals !== 'function') {
            return;
        }

        const previousWindow = { previous: true };
        const previousRequestAnimationFrame = vi.fn(() => 9);
        vi.stubGlobal('window', previousWindow);
        vi.stubGlobal('requestAnimationFrame', previousRequestAnimationFrame);

        const callback = vi.fn();

        await withPopoverWebGlobals(async () => {
            expect(globalThis.window).not.toBe(previousWindow);
            expect(typeof globalThis.window.addEventListener).toBe('function');
            expect(typeof globalThis.window.removeEventListener).toBe('function');

            const frameId = globalThis.requestAnimationFrame(callback);
            expect(frameId).toBe(0);
            expect(callback).toHaveBeenCalledTimes(1);
        });

        expect(globalThis.window).toBe(previousWindow);
        expect(globalThis.requestAnimationFrame).toBe(previousRequestAnimationFrame);
    });

    it('returns the first host node matching a testID when wrappers and host nodes share the same props', async () => {
        const harnessModule = await import('./popoverHarness');
        const findFirstHostNodeByTestId = Reflect.get(harnessModule, 'findFirstHostNodeByTestId');

        expect(typeof findFirstHostNodeByTestId).toBe('function');

        if (typeof findFirstHostNodeByTestId !== 'function') {
            return;
        }

        const Wrapper = (props: { testID: string }) => React.createElement('View', props);
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Wrapper, { testID: 'popover-anchor-overlay' }));
        });

        const host = findFirstHostNodeByTestId(tree, 'popover-anchor-overlay');
        expect(host).not.toBeNull();
        expect(host?.type).toBe('View');
    });
});

import { describe, expect, it, vi } from 'vitest';

import { focusActionOperationHeading } from './focusActionOperationHeading';

describe('focusActionOperationHeading', () => {
    it('focuses the web heading without invoking native accessibility focus', () => {
        const focus = vi.fn();
        const setNativeFocus = vi.fn();

        focusActionOperationHeading({ focus }, {
            platform: 'web',
            setNativeFocus,
        });

        expect(focus).toHaveBeenCalledTimes(1);
        expect(setNativeFocus).not.toHaveBeenCalled();
    });

    it('also requests native accessibility focus outside web', () => {
        const node = { focus: vi.fn() };
        const setNativeFocus = vi.fn();

        focusActionOperationHeading(node, {
            platform: 'ios',
            setNativeFocus,
        });

        expect(node.focus).toHaveBeenCalledTimes(1);
        expect(setNativeFocus).toHaveBeenCalledWith(node);
    });
});

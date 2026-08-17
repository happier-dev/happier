import { describe, expect, it, vi } from 'vitest';

import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';

type FocusPresentationHost = Readonly<{
    focusTarget?(target: unknown): boolean;
}>;

describe('createPluginUiPrivatePresentationHost focus transfer', () => {
    it('fails closed until the current layout fact permits it, then rechecks that fact on the same old host handle', () => {
        const current = { eligible: false };
        const target = { focus: vi.fn() };
        const host = createPluginUiPrivatePresentationHost(undefined, {
            isFocusEligible: () => current.eligible,
        }) as FocusPresentationHost;

        expect(host.focusTarget?.(target)).toBe(false);
        expect(target.focus).not.toHaveBeenCalled();

        const oldHostHandle = host;
        current.eligible = true;
        expect(oldHostHandle.focusTarget?.(target)).toBe(true);
        expect(target.focus).toHaveBeenCalledTimes(1);

        current.eligible = false;
        expect(oldHostHandle.focusTarget?.(target)).toBe(false);
        expect(target.focus).toHaveBeenCalledTimes(1);
    });
});

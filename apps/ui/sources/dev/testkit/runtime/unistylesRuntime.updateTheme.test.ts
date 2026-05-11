import { describe, expect, it, vi } from 'vitest';

import { createUnistylesRuntime } from './unistylesRuntime';

describe('createUnistylesRuntime updateTheme support', () => {
    it('provides updateTheme in the default UnistylesRuntime mock', async () => {
        const moduleMock = await createUnistylesRuntime();

        expect(typeof moduleMock.UnistylesRuntime.updateTheme).toBe('function');
    });

    it('allows tests to override updateTheme through the canonical runtime helper', async () => {
        const updateTheme = vi.fn();
        const moduleMock = await createUnistylesRuntime({
            runtime: { updateTheme },
        });

        moduleMock.UnistylesRuntime.updateTheme('light', (theme: unknown) => theme);

        expect(updateTheme).toHaveBeenCalledWith('light', expect.any(Function));
    });
});

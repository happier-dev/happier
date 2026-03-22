import { describe, expect, it } from 'vitest';

describe('waitForCondition', () => {
    it('resolves once an async condition becomes true', async () => {
        const mod = await import('./waitFor');
        let attempts = 0;

        await expect(
            mod.waitForCondition(async () => {
                attempts += 1;
                return attempts >= 3;
            }, { timeoutMs: 100, intervalMs: 1, label: 'eventual truthy condition' }),
        ).resolves.toBeUndefined();

        expect(attempts).toBeGreaterThanOrEqual(3);
    });

    it('includes debug output in timeout failures', async () => {
        const mod = await import('./waitFor');

        await expect(
            mod.waitForCondition(
                () => false,
                {
                    timeoutMs: 10,
                    intervalMs: 1,
                    label: 'stuck condition',
                    debug: () => 'debug details',
                },
            ),
        ).rejects.toThrow(/debug details/);
    });
});

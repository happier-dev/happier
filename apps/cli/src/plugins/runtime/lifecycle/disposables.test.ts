import { describe, expect, it, vi } from 'vitest';

import { createPluginDisposableRegistry } from './disposables';

describe('createPluginDisposableRegistry', () => {
    it('disposes late registrations immediately after plugin cleanup has run', async () => {
        const first = vi.fn();
        const late = vi.fn();
        const registry = createPluginDisposableRegistry();

        registry.add(first);
        await registry.dispose();
        registry.add(late);

        expect(first).toHaveBeenCalledTimes(1);
        expect(late).toHaveBeenCalledTimes(1);
        await registry.dispose();
        expect(first).toHaveBeenCalledTimes(1);
        expect(late).toHaveBeenCalledTimes(1);
    });

    it('runs every disposable in reverse order before reporting cleanup failures', async () => {
        const calls: string[] = [];
        const registry = createPluginDisposableRegistry();
        registry.add(async () => {
            calls.push('survivor');
        });
        registry.add(async () => {
            calls.push('failure');
            throw new Error('cleanup failed');
        });

        await expect(registry.dispose()).rejects.toThrow(/cleanup failed/i);
        expect(calls).toEqual(['failure', 'survivor']);
    });

    it('returns one sticky promise to every concurrent disposal caller', async () => {
        let releaseCleanup: (() => void) | undefined;
        const registry = createPluginDisposableRegistry();
        registry.add(() => new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        }));

        const first = registry.dispose();
        const second = registry.dispose();

        expect(second).toBe(first);
        let secondSettled = false;
        void second.then(() => { secondSettled = true; });
        await Promise.resolve();
        expect(secondSettled).toBe(false);
        releaseCleanup?.();
        await expect(first).resolves.toBeUndefined();
        expect(secondSettled).toBe(true);
    });
});

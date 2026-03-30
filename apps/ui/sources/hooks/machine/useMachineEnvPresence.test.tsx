import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import { invalidateMachineEnvPresence, useMachineEnvPresence } from './useMachineEnvPresence';

const machinePreviewEnvSpy = vi.hoisted(() => vi.fn());
const REQUIRED_KEYS = ['OPENAI_API_KEY'];

vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: (...args: unknown[]) => machinePreviewEnvSpy(...args),
}));

describe('useMachineEnvPresence', () => {
    beforeEach(() => {
        invalidateMachineEnvPresence();
        machinePreviewEnvSpy.mockReset();
        machinePreviewEnvSpy.mockResolvedValue({
            supported: true,
            response: {
                values: {
                    OPENAI_API_KEY: { isSet: true, display: 'set' },
                },
            },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('invalidates server-scoped cache entries when clearing by machine id', async () => {
        const first = await renderHook(
            () => useMachineEnvPresence('m1', REQUIRED_KEYS, { ttlMs: 60_000, serverId: 'server-a' }),
            { flushOptions: { cycles: 0 } },
        );
        await flushHookEffects();
        await first.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(1);

        invalidateMachineEnvPresence({ machineId: 'm1' });

        const second = await renderHook(
            () => useMachineEnvPresence('m1', REQUIRED_KEYS, { ttlMs: 60_000, serverId: 'server-a' }),
            { flushOptions: { cycles: 0 } },
        );
        await flushHookEffects();
        await second.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(2);
    });

    it('can invalidate only one server-scoped machine cache entry', async () => {
        const first = await renderHook(
            () => useMachineEnvPresence('m1', REQUIRED_KEYS, { ttlMs: 60_000, serverId: 'server-a' }),
            { flushOptions: { cycles: 0 } },
        );
        await flushHookEffects();
        await first.unmount();

        const second = await renderHook(
            () => useMachineEnvPresence('m1', REQUIRED_KEYS, { ttlMs: 60_000, serverId: 'server-b' }),
            { flushOptions: { cycles: 0 } },
        );
        await flushHookEffects();
        await second.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(2);

        invalidateMachineEnvPresence({ machineId: 'm1', serverId: 'server-a' });

        const third = await renderHook(
            () => useMachineEnvPresence('m1', REQUIRED_KEYS, { ttlMs: 60_000, serverId: 'server-b' }),
            { flushOptions: { cycles: 0 } },
        );
        await flushHookEffects();
        await third.unmount();

        const fourth = await renderHook(
            () => useMachineEnvPresence('m1', REQUIRED_KEYS, { ttlMs: 60_000, serverId: 'server-a' }),
            { flushOptions: { cycles: 0 } },
        );
        await flushHookEffects();
        await fourth.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(3);
    });
});

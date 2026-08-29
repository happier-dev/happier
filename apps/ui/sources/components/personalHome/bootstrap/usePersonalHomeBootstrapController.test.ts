import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import { usePersonalHomeBootstrapController } from './usePersonalHomeBootstrapController';
import type { PersonalHomeFacts } from './personalHomeBootstrapTypes';

function facts(overrides: Partial<PersonalHomeFacts> = {}): PersonalHomeFacts {
    return {
        hostIsDesktop: true,
        isDesktopMainWindow: true,
        completedPersonalHomeProfile: null,
        candidateLocalProfile: null,
        relayRuntime: { installed: true, healthy: true, status: 'healthy' },
        localHomeReachability: 'reachable',
        localHomeIdentity: 'home-1',
        localHomeAuth: 'present',
        anonymousSignup: 'enabled',
        daemon: null,
        activeTask: null,
        ...overrides,
    };
}

describe('usePersonalHomeBootstrapController', () => {
    it('re-reads authoritative facts after each idempotent operation', async () => {
        let current = facts();
        const readFacts = vi.fn(async () => current);
        const closeSignup = vi.fn(async () => {
            current = facts({ anonymousSignup: 'disabled' });
        });

        const hook = await renderHook(() => usePersonalHomeBootstrapController({
            readFacts,
            operations: { 'close-signup': closeSignup },
        }));
        await flushHookEffects();

        expect(closeSignup).toHaveBeenCalledTimes(1);
        expect(readFacts.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(hook.getCurrent().snapshot.shouldGateShell).toBe(false);
    });

    it('turns operation failures into a retryable blocked snapshot', async () => {
        const readFacts = vi.fn(async () => facts({ relayRuntime: null }));
        const prepareHome = vi.fn(async () => { throw new Error('download failed'); });

        const hook = await renderHook(() => usePersonalHomeBootstrapController({
            readFacts,
            operations: { 'prepare-home': prepareHome },
        }));
        await flushHookEffects();

        expect(prepareHome).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().snapshot).toMatchObject({
            phase: 'blocked',
            action: 'retry',
            shouldGateShell: true,
        });
        expect(hook.getCurrent().error?.message).toContain('download failed');
    });
});

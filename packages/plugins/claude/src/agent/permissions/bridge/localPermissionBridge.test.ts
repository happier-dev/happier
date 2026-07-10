import { describe, expect, it, vi } from 'vitest';

import {
    ClaudeLocalPermissionBridgeOptInTimeoutError,
    waitForClaudeLocalPermissionBridgeOptIn,
} from './localPermissionBridge.js';

describe('Claude local permission bridge opt-in wait', () => {
    it('resolves with the opt-in payload when it arrives before the bridge timer', async () => {
        await expect(waitForClaudeLocalPermissionBridgeOptIn({
            arrival: Promise.resolve({ enabled: true }),
            timeoutMs: 1_000,
        })).resolves.toEqual({ enabled: true });
    });

    it('rejects with the explicit bridge opt-in timeout error when no opt-in arrives', async () => {
        vi.useFakeTimers();
        try {
            const wait = waitForClaudeLocalPermissionBridgeOptIn({
                arrival: new Promise<never>(() => {}),
                timeoutMs: 25,
            });
            const rejection = expect(wait).rejects.toBeInstanceOf(ClaudeLocalPermissionBridgeOptInTimeoutError);

            await vi.advanceTimersByTimeAsync(25);

            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });
});

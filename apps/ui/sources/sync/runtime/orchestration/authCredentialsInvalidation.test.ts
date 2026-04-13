import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    notifyAuthCredentialsInvalidated,
    subscribeAuthCredentialsInvalidation,
} from './authCredentialsInvalidation';

describe('authCredentialsInvalidation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('delivers only the minimal invalidation payload to subscribers', async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeAuthCredentialsInvalidation(listener);
        try {
            notifyAuthCredentialsInvalidated({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                token: 'sensitive-token',
            });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledWith({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
            });
        } finally {
            unsubscribe();
        }
    });

    it('reports async subscriber failures instead of silently swallowing them', async () => {
        const error = new Error('listener-failed');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const unsubscribe = subscribeAuthCredentialsInvalidation(async () => {
            throw error;
        });
        try {
            notifyAuthCredentialsInvalidated({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                token: 'sensitive-token',
            });
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
            expect(consoleErrorSpy.mock.calls.some(([value]) => {
                return String(value).includes('[fireAndForget] authCredentialsInvalidation.listener');
            })).toBe(true);
        } finally {
            unsubscribe();
        }
    });
});

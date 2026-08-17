import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    notifyAuthCredentialsInvalidated,
    subscribeAuthCredentialsInvalidation,
} from './authCredentialsInvalidation';
import type {
    AccountEncryptionFirstKeyRecoveryHandle,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

describe('authCredentialsInvalidation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('delivers the credential-removal outcome without the rejected bearer', async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeAuthCredentialsInvalidation(listener);
        try {
            notifyAuthCredentialsInvalidated({
                kind: 'credentials_removed',
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
            });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledWith({
                kind: 'credentials_removed',
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
            });
        } finally {
            unsubscribe();
        }
    });

    it('delivers the opaque first-key recovery handle for degraded auth presentation', async () => {
        const listener = vi.fn();
        const recovery = {
            pending: {},
        } as unknown as AccountEncryptionFirstKeyRecoveryHandle;
        const unsubscribe = subscribeAuthCredentialsInvalidation(listener);
        try {
            notifyAuthCredentialsInvalidated({
                kind: 'first_key_recovery_required',
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                recovery,
            });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledWith({
                kind: 'first_key_recovery_required',
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                recovery,
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
                kind: 'credentials_removed',
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
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

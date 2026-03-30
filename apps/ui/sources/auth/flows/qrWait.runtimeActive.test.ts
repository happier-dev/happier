import { beforeAll, describe, expect, it, vi } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { generateAuthKeyPair } from './qrStart';
import { authQRWait } from './qrWait';
import { serverFetch } from '@/sync/http/client';

const appState = vi.hoisted(() => ({ currentState: 'background' as string }));

vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: { OS: 'web' },
                AppState: {
                    get currentState() {
                        return appState.currentState;
                    },
                },
            }
    );
});

type StubResponse = {
    ok: boolean;
    status: number;
    json: () => Promise<any>;
};

function makeJsonResponse(status: number, payload: any): StubResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    };
}

describe('authQRWait runtime active gating', () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    it('does not poll the server while runtime is inactive (background/hidden)', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();

        const fetchMock = vi.mocked(serverFetch);
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(makeJsonResponse(200, { state: 'requested' }) as any);

        let loopCount = 0;
        const outPromise = authQRWait(keypair, undefined, () => loopCount++ >= 1);

        await vi.advanceTimersByTimeAsync(1100);

        await expect(outPromise).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(0);

        vi.useRealTimers();
    });
});

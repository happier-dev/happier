import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    waitForServerReachable,
} from './serverReachabilitySupervisorPool';

describe('serverReachabilitySupervisorPool (abort semantics)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(async () => {
        vi.useRealTimers();
        resetRuntimeFetch();
        await resetServerReachabilitySupervisors();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('rejects waitForServerReachable with an AbortError when aborted', async () => {
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        await startServerReachabilitySupervisor({ serverUrl: 'https://example.test', token: null });

        const abortController = new AbortController();
        const waitPromise = waitForServerReachable({
            serverUrl: 'https://example.test',
            token: null,
            signal: abortController.signal,
            timeoutMs: 50_000,
        });

        abortController.abort();

        await expect(waitPromise).rejects.toMatchObject({ name: 'AbortError' });
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiSessionClient } from './sessionClient';

describe('ApiSessionClient startup transcript catch-up retries', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps retrying startup transcript catch-up after messages have already been observed', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            lastObservedMessageSeq: number;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (afterSeq: number) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.lastObservedMessageSeq = 1;
        client.startupMessageCatchUpInitialAfterSeq = 1;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {});
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(1);
        expect(client.catchUpSessionMessages).toHaveBeenCalledWith(1);
    });

    it('retries startup transcript catch-up from the initial afterSeq even if a local echo advances the live cursor', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            lastObservedMessageSeq: number;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (afterSeq: number) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.lastObservedMessageSeq = 1;
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {});
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(1);
        expect(client.catchUpSessionMessages).toHaveBeenCalledWith(0);
    });
});

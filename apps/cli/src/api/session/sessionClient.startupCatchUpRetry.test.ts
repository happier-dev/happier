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

    it('captures the startup catch-up baseline before seeding the daemon initial prompt advances the live cursor', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            socket: { connected: boolean };
            userSocket: { connected: boolean; connect: () => void; disconnect: () => void };
            currentConnectionState: { phase: 'idle' | 'connecting' | 'online' | 'error' };
            userMessageCallbackAttachedAtMs: number | null;
            pendingMessages: unknown[];
            pendingMessageCallback: ((message: unknown) => void) | null;
            onUserMessage: (callback: (data: unknown) => void) => void;
            daemonInitialPrompt: string | null;
            daemonInitialPromptSeeded: boolean;
            lastObservedMessageSeq: number;
            startupMessageCatchUpStarted: boolean;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            enqueueSessionUserMessage: ReturnType<typeof vi.fn>;
            catchUpSessionMessages: ReturnType<typeof vi.fn>;
            scheduleNextStartupMessageCatchUpRetry: () => void;
            kickUserSocketConnect: () => void;
            maybeScheduleUserSocketDisconnect: () => void;
        };

        client.closed = false;
        client.socket = { connected: true };
        client.userSocket = {
            connected: false,
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
        client.currentConnectionState = { phase: 'online' };
        client.userMessageCallbackAttachedAtMs = null;
        client.pendingMessages = [];
        client.pendingMessageCallback = null;
        client.daemonInitialPrompt = 'daemon-startup-prompt';
        client.daemonInitialPromptSeeded = false;
        client.lastObservedMessageSeq = 0;
        client.startupMessageCatchUpStarted = false;
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.enqueueSessionUserMessage = vi.fn(() => {
            client.lastObservedMessageSeq = 1;
        });
        client.catchUpSessionMessages = vi.fn(async () => {});
        client.scheduleNextStartupMessageCatchUpRetry = vi.fn();
        client.kickUserSocketConnect = vi.fn();
        client.maybeScheduleUserSocketDisconnect = vi.fn();

        client.onUserMessage(() => {});

        expect(client.startupMessageCatchUpInitialAfterSeq).toBe(0);
        expect(client.catchUpSessionMessages).toHaveBeenCalledWith(0);
        expect(client.catchUpSessionMessages.mock.invocationCallOrder[0]).toBeLessThan(
            client.enqueueSessionUserMessage.mock.invocationCallOrder[0],
        );
    });
});

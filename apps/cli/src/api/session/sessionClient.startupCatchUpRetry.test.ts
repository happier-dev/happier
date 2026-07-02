import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { HttpStatusError } from '../client/httpStatusError';

import { ApiSessionClient } from './sessionClient';

function createOnlineConnectionState() {
    return {
        phase: 'online',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    } as const;
}

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
        expect((client.catchUpSessionMessages as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(1);
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
        expect((client.catchUpSessionMessages as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(0);
    });

    it('does not schedule another startup transcript retry after catch-up succeeds', async () => {
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
        client.lastObservedMessageSeq = 0;
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {});
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_200);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(1);
        expect((client.catchUpSessionMessages as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(0);
    });

    it('rewinds the startup catch-up baseline before first daemon transcript catch-up', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            socket: { connected: boolean };
            userSocket: { connected: boolean; connect: () => void; disconnect: () => void };
            currentConnectionState: { phase: 'online' };
            userMessageCallbackAttachedAtMs: number | null;
            pendingMessages: unknown[];
            pendingMessageCallback: ((message: unknown) => void) | null;
            onUserMessage: (callback: (data: unknown) => void) => void;
            daemonInitialPrompt: string | null;
            daemonInitialPromptSeeded: boolean;
            startedByDaemonProcess: boolean;
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
        client.daemonInitialPrompt = null;
        client.daemonInitialPromptSeeded = false;
        client.startedByDaemonProcess = true;
        client.lastObservedMessageSeq = 4;
        client.startupMessageCatchUpStarted = false;
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.enqueueSessionUserMessage = vi.fn();
        client.catchUpSessionMessages = vi.fn(async () => {});
        client.scheduleNextStartupMessageCatchUpRetry = vi.fn();
        client.kickUserSocketConnect = vi.fn();
        client.maybeScheduleUserSocketDisconnect = vi.fn();

        client.onUserMessage(() => {});

        expect(client.startupMessageCatchUpInitialAfterSeq).toBe(3);
        expect(client.catchUpSessionMessages.mock.calls[0]?.[0]).toBe(3);
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

    it('reports terminal auth failures from transcript catch-up into the session supervisor', async () => {
        const reportProbeResult = vi.fn();
        vi.spyOn(axios, 'get').mockRejectedValueOnce(new HttpStatusError(401, 'expired token'));

        const client = Object.create(ApiSessionClient.prototype) as {
            token: string;
            sessionId: string;
            sessionConnectionSupervisor: {
                getState: () => ReturnType<typeof createOnlineConnectionState>;
                reportProbeResult: ReturnType<typeof vi.fn>;
            };
            handleUpdate: ReturnType<typeof vi.fn>;
            catchUpSessionMessages: (afterSeq: number) => Promise<void>;
        };

        client.token = 'expired';
        client.sessionId = 's1';
        client.sessionConnectionSupervisor = {
            getState: () => createOnlineConnectionState(),
            reportProbeResult,
        };
        client.handleUpdate = vi.fn();

        await expect(client.catchUpSessionMessages(10)).rejects.toMatchObject({
            name: 'HttpStatusError',
            code: 'not_authenticated',
            response: { status: 401 },
        });
        expect(reportProbeResult).toHaveBeenCalledWith(expect.objectContaining({
            status: 'auth_failed',
            statusCode: 401,
        }));
    });

    it('does not keep retrying startup transcript catch-up after terminal auth', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            currentConnectionState: ReturnType<typeof createOnlineConnectionState>;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (afterSeq: number) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.currentConnectionState = createOnlineConnectionState();
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {
            throw new HttpStatusError(401, 'expired token');
        });
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_200);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(1);
    });

    it('keeps retrying startup transcript catch-up after non-auth failures', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            currentConnectionState: ReturnType<typeof createOnlineConnectionState>;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (afterSeq: number) => Promise<void>;
            shouldRunStartupTranscriptCatchUp: () => boolean;
            scheduleNextStartupMessageCatchUpRetry: () => void;
        };

        client.closed = false;
        client.currentConnectionState = createOnlineConnectionState();
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi
            .fn()
            .mockRejectedValueOnce(new Error('temporary server failure'))
            .mockResolvedValue(undefined);
        client.shouldRunStartupTranscriptCatchUp = vi.fn(() => true);

        client.scheduleNextStartupMessageCatchUpRetry();

        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_200);
        await Promise.resolve();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(2);
        expect((client.catchUpSessionMessages as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(0);
        expect((client.catchUpSessionMessages as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toBe(0);
    });
});

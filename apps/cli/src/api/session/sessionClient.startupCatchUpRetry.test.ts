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

    it('bounds daemon startup transcript retries after the initial catch-up succeeds', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            pendingMessageCallback: null;
            userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null;
            kickUserSocketConnect: () => void;
            pendingMessages: unknown[];
            bufferedPendingMessageDeliveryInfoByLocalId: Map<string, unknown>;
            startupMessageCatchUpStarted: boolean;
            startupMessageCatchUpExplicitAfterSeq: number | null;
            startedByDaemonProcess: boolean;
            metadata: null;
            closed: boolean;
            currentConnectionState: ReturnType<typeof createOnlineConnectionState>;
            lastObservedMessageSeq: number;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; replayPreviouslyObservedMessageIdsForObservation?: boolean }) => Promise<void>;
            onUserMessage: (callback: () => void) => void;
        };

        client.pendingMessageCallback = null;
        client.userSocketDisconnectTimer = null;
        client.kickUserSocketConnect = vi.fn();
        client.pendingMessages = [];
        client.bufferedPendingMessageDeliveryInfoByLocalId = new Map();
        client.startupMessageCatchUpStarted = false;
        client.startupMessageCatchUpExplicitAfterSeq = 7;
        client.startedByDaemonProcess = true;
        client.metadata = null;
        client.closed = false;
        client.currentConnectionState = createOnlineConnectionState();
        client.lastObservedMessageSeq = 9;
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi.fn(async () => {});

        client.onUserMessage(() => {});

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(4);
        for (let callIndex = 1; callIndex <= 4; callIndex += 1) {
            expect(client.catchUpSessionMessages).toHaveBeenNthCalledWith(callIndex, {
                afterSeq: 7,
                replayPreviouslyObservedMessageIdsForObservation: true,
            });
        }
    });

    it('retries startup transcript catch-up from the initial afterSeq even if a local echo advances the live cursor', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            lastObservedMessageSeq: number;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; replayPreviouslyObservedMessageIdsForObservation: boolean }) => Promise<void>;
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
        expect(client.catchUpSessionMessages).toHaveBeenCalledWith({
            afterSeq: 0,
            replayPreviouslyObservedMessageIdsForObservation: true,
        });
    });

    it('reports terminal auth failures from transcript catch-up into the session supervisor', async () => {
        const reportProbeResult = vi.fn();
        const authError = new HttpStatusError(401, 'expired token');
        vi.spyOn(axios, 'get').mockRejectedValueOnce(authError);

        const client = Object.create(ApiSessionClient.prototype) as {
            token: string;
            sessionId: string;
            sessionConnectionSupervisor: {
                getState: () => ReturnType<typeof createOnlineConnectionState>;
                reportProbeResult: ReturnType<typeof vi.fn>;
            };
            handleUpdate: ReturnType<typeof vi.fn>;
            catchUpSessionMessages: (request: { afterSeq: number; replayPreviouslyObservedMessageIdsForObservation: boolean }) => Promise<void>;
        };

        client.token = 'expired';
        client.sessionId = 's1';
        client.sessionConnectionSupervisor = {
            getState: () => createOnlineConnectionState(),
            reportProbeResult,
        };
        client.handleUpdate = vi.fn();

        await expect(client.catchUpSessionMessages({
            afterSeq: 10,
            replayPreviouslyObservedMessageIdsForObservation: true,
        })).rejects.toMatchObject({
            name: 'HttpStatusError',
            code: 'not_authenticated',
            response: { status: 401 },
        });
        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: 401,
            errorMessage: expect.stringContaining('Authentication failed during session message catch-up'),
        });
    });

    it('does not keep retrying startup transcript catch-up after terminal auth', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            closed: boolean;
            currentConnectionState: ReturnType<typeof createOnlineConnectionState>;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; authorization: 'startup_recovery' | 'explicit_cursor' | 'reconnect_watermark' }) => Promise<void>;
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

    it('bounds daemon startup retries after a transient failure and preserves the initial cursor', async () => {
        const client = Object.create(ApiSessionClient.prototype) as {
            pendingMessageCallback: null;
            userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null;
            kickUserSocketConnect: () => void;
            pendingMessages: unknown[];
            bufferedPendingMessageDeliveryInfoByLocalId: Map<string, unknown>;
            startupMessageCatchUpStarted: boolean;
            startupMessageCatchUpExplicitAfterSeq: number | null;
            startedByDaemonProcess: boolean;
            metadata: null;
            closed: boolean;
            currentConnectionState: ReturnType<typeof createOnlineConnectionState>;
            lastObservedMessageSeq: number;
            startupMessageCatchUpInitialAfterSeq: number;
            startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
            startupMessageCatchUpRetryIndex: number;
            catchUpSessionMessages: (request: { afterSeq: number; replayPreviouslyObservedMessageIdsForObservation?: boolean }) => Promise<void>;
            onUserMessage: (callback: () => void) => void;
        };

        client.pendingMessageCallback = null;
        client.userSocketDisconnectTimer = null;
        client.kickUserSocketConnect = vi.fn();
        client.pendingMessages = [];
        client.bufferedPendingMessageDeliveryInfoByLocalId = new Map();
        client.startupMessageCatchUpStarted = false;
        client.startupMessageCatchUpExplicitAfterSeq = 7;
        client.startedByDaemonProcess = true;
        client.metadata = null;
        client.closed = false;
        client.currentConnectionState = createOnlineConnectionState();
        client.lastObservedMessageSeq = 9;
        client.startupMessageCatchUpInitialAfterSeq = 0;
        client.startupMessageCatchUpRetryTimer = null;
        client.startupMessageCatchUpRetryIndex = 0;
        client.catchUpSessionMessages = vi
            .fn()
            .mockRejectedValueOnce(new Error('temporary server failure'))
            .mockResolvedValue(undefined);

        client.onUserMessage(() => {});

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(client.catchUpSessionMessages).toHaveBeenCalledTimes(4);
        for (let callIndex = 1; callIndex <= 4; callIndex += 1) {
            expect(client.catchUpSessionMessages).toHaveBeenNthCalledWith(callIndex, {
                afterSeq: 7,
                replayPreviouslyObservedMessageIdsForObservation: true,
            });
        }
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { HttpStatusError } from '../client/httpStatusError';

import { ApiSessionClient } from './sessionClient';
import * as startupCatchUpRuntime from './client/lifecycle/startupCatchUpRuntime';
import { createSessionClientRecoveryRuntime } from './client/lifecycle/createSessionClientRecoveryRuntime';
import type { SessionCatchUpRequest } from './sessionChangesSyncOnConnect';

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

    it('keeps startup user-message attachment owned by the interaction API', () => {
        expect(startupCatchUpRuntime).not.toHaveProperty('attachSessionUserMessageHandler');
    });

    it('requires the canonical recovery runtime instead of retaining a direct transport fallback', async () => {
        const axiosGet = vi.spyOn(axios, 'get').mockResolvedValueOnce({ data: { messages: [] } });

        await expect(startupCatchUpRuntime.catchUpSessionMessagesViaPort({
            token: 'token',
            sessionId: 's1',
            sessionConnectionSupervisor: null,
            handleCatchUpUpdate: vi.fn(),
        } as never, { afterSeq: 0 })).rejects.toThrow('requires recoveryRuntime');
        expect(axiosGet).not.toHaveBeenCalled();
        axiosGet.mockRestore();
    });

    it('requires the canonical recovery runtime instead of retaining a retry-timer fallback', () => {
        expect(() => startupCatchUpRuntime.scheduleNextStartupCatchUpRetryViaPort(
            {} as never,
        )).toThrow('requires recoveryRuntime');
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
            recoveryRuntime: ReturnType<typeof createSessionClientRecoveryRuntime>;
            catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
        };

        client.token = 'expired';
        client.sessionId = 's1';
        client.sessionConnectionSupervisor = {
            getState: () => createOnlineConnectionState(),
            reportProbeResult,
        };
        client.handleUpdate = vi.fn();
        client.recoveryRuntime = createSessionClientRecoveryRuntime({
            startupMessageCatchUpRetryDelaysMs: [],
            token: client.token,
            sessionId: client.sessionId,
            getClosed: () => false,
            getSessionConnectionSupervisor: () => client.sessionConnectionSupervisor as never,
            getCurrentConnectionState: () => createOnlineConnectionState(),
            getStartedByDaemonProcess: () => false,
            getMetadataStartedBy: () => null,
            getMetadataStartedFromDaemon: () => false,
            getStartupMessageCatchUpRetryIndex: () => 0,
            setStartupMessageCatchUpRetryIndex: () => {},
            getStartupMessageCatchUpInitialAfterSeq: () => 0,
            getStartupMessageCatchUpInitialAfterSeqIsExplicit: () => false,
            getLastObservedMessageSeq: () => 0,
            handleUpdate: (update) => client.handleUpdate(update),
            syncSessionSnapshotFromServer: async () => true,
            applyPendingQueueState: () => {},
        });

        await expect(client.catchUpSessionMessages({
            afterSeq: 10,
        })).rejects.toMatchObject({
            name: 'HttpStatusError',
            code: 'not_authenticated',
            response: { status: 401 },
        });
        expect(reportProbeResult).toHaveBeenCalledWith(expect.objectContaining({
            status: 'auth_failed',
            statusCode: 401,
        }));
    });

});

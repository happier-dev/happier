import {
    SPAWN_SESSION_ERROR_CODES,
    buildProviderAccountUsageRecordId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAccountUsageAdoptionV1 } from './connectedServices/accountUsage/adoption';
import { recordProviderAccountUsageAdoptionForSession } from './connectedServices/accountUsage/recordProviderAccountUsageSnapshotForSession';
import { createProviderAccountUsageStore } from './connectedServices/accountUsage/store';

import { createDaemonControlApp } from './controlServer';

function createApp(overrides: Partial<Parameters<typeof createDaemonControlApp>[0]> = {}) {
    return createDaemonControlApp({
        getChildren: () => [],
        machineId: 'machine',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'unused',
        }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        controlToken: 'token',
        ...overrides,
    });
}

function createSnapshot(): ProviderAccountUsageSnapshotV1 {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: 'acct_123' },
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 300_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        meters: [],
    };
}

function createAdoption(): ProviderAccountUsageAdoptionV1 {
    const fromKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'codex',
        accountSubjectId: 'provisional:native',
        subjectKind: 'unknown',
        quotaScope: 'account',
    };
    const stableRecordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        providerId: 'codex',
        fromRecordId: buildProviderAccountUsageRecordId(fromKey),
        toRecordId: buildProviderAccountUsageRecordId(stableRecordKey),
        stableRecordKey,
        proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
        observedAtMs: 2_000,
    };
}

describe('createDaemonControlApp provider account usage routes', () => {
    it('dispatches canonical provider account usage snapshots to the daemon handler', async () => {
        const snapshot = createSnapshot();
        const source: ConnectedServiceUsageSourceV1 = {
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        };
        const handleProviderAccountUsageSnapshot = vi.fn(async () => ({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        }));
        const app = createApp({
            handleProviderAccountUsageSnapshot,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-snapshot',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    snapshot,
                    source,
                    credentialFingerprint: 'sha256:deadbeef',
                    policyDisposition: 'evidence_only',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: { status: 'snapshot_advanced', recordId: snapshot.recordId, persisted: true },
            });
            expect(handleProviderAccountUsageSnapshot).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                snapshot,
                source,
                credentialFingerprint: 'sha256:deadbeef',
                policyDisposition: 'evidence_only',
            });
        } finally {
            await app.close();
        }
    });

    it.each([
        ['unknown session', async () => ({ status: 'session_not_found' as const })],
        ['persistence not accepted', async () => ({
            status: 'snapshot_advanced' as const,
            recordId: createSnapshot().recordId,
            persisted: false,
        })],
        ['intake failure', async () => { throw new Error('persistence unavailable'); }],
    ])('rejects canonical provider usage custody for %s so the producer can retry', async (_label, handler) => {
        const snapshot = createSnapshot();
        const app = createApp({
            handleProviderAccountUsageSnapshot: handler,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-snapshot',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_retry',
                    snapshot,
                },
            });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'provider_account_usage_snapshot_intake_failed',
            });
        } finally {
            await app.close();
        }
    });

    it('terminally accepts an exact credential mismatch without retrying stale account usage', async () => {
        const snapshot = createSnapshot();
        const app = createApp({
            handleProviderAccountUsageSnapshot: async () => ({
                status: 'credential_fingerprint_mismatch' as const,
                recordId: snapshot.recordId,
                persisted: false,
            }),
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-snapshot',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_stale',
                    snapshot,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: {
                    status: 'credential_fingerprint_mismatch',
                    recordId: snapshot.recordId,
                    persisted: false,
                },
            });
        } finally {
            await app.close();
        }
    });

    it('rejects provider account usage snapshots while daemon shutdown is quiescing producers', async () => {
        const snapshot = createSnapshot();
        const handleProviderAccountUsageSnapshot = vi.fn(async () => ({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        }));
        const app = createApp({
            isShuttingDown: () => true,
            handleProviderAccountUsageSnapshot,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-snapshot',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    snapshot,
                },
            });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'daemon_shutting_down',
            });
            expect(handleProviderAccountUsageSnapshot).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('dispatches provider-owned usage adoption to the daemon handler', async () => {
        const adoption = createAdoption();
        const handleProviderAccountUsageAdoption = vi.fn(async () => ({
            status: 'adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
            persisted: true,
        }));
        const app = createApp({
            handleProviderAccountUsageAdoption,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-adoption',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    adoption,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: {
                    status: 'adopted',
                    fromRecordId: adoption.fromRecordId,
                    toRecordId: adoption.toRecordId,
                    persisted: true,
                },
            });
            expect(handleProviderAccountUsageAdoption).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                adoption,
            });
        } finally {
            await app.close();
        }
    });

    it('returns retryable unavailability before adoption custody and commits one identical live-route retry', async () => {
        const adoption = createAdoption();
        const store = createProviderAccountUsageStore();
        const persistence = {
            recordInBandSnapshot: vi.fn()
                .mockRejectedValueOnce(new Error('provider account usage persistence unavailable'))
                .mockResolvedValue({ status: 'enqueued' }),
        };
        store.recordSnapshot(createSnapshot());
        const handleProviderAccountUsageAdoption = vi.fn(async (input: Readonly<{
            sessionId: string;
            adoption: ProviderAccountUsageAdoptionV1;
        }>) => await recordProviderAccountUsageAdoptionForSession({
            getChildren: () => [{ happySessionId: 'sess_1' }],
            store,
            persistence,
            sessionId: input.sessionId,
            adoption: input.adoption,
        }));
        const app = createApp({
            handleProviderAccountUsageAdoption,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-adoption',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    adoption,
                },
            });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'provider_account_usage_adoption_intake_failed',
            });
            expect(store.resolveRecordId(adoption.fromRecordId)).toBeNull();

            const retryResponse = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-adoption',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    adoption,
                },
            });
            expect(retryResponse.statusCode).toBe(200);
            expect(retryResponse.json()).toEqual({
                ok: true,
                result: {
                    status: 'adopted',
                    fromRecordId: adoption.fromRecordId,
                    toRecordId: adoption.toRecordId,
                    persisted: true,
                },
            });
            expect(store.resolveRecordId(adoption.fromRecordId)?.recordId).toBe(adoption.toRecordId);

            const duplicateResponse = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-adoption',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    adoption,
                },
            });
            expect(duplicateResponse.statusCode).toBe(200);
            expect(duplicateResponse.json()).toEqual({
                ok: true,
                result: {
                    status: 'already_adopted',
                    fromRecordId: adoption.fromRecordId,
                    toRecordId: adoption.toRecordId,
                    persisted: true,
                },
            });
            expect(persistence.recordInBandSnapshot).toHaveBeenCalledTimes(2);
            expect(handleProviderAccountUsageAdoption).toHaveBeenCalledTimes(3);
        } finally {
            await app.close();
        }
    });

    it('rejects provider-owned usage adoption while daemon shutdown is quiescing producers', async () => {
        const adoption = createAdoption();
        const handleProviderAccountUsageAdoption = vi.fn(async () => ({
            status: 'adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
        }));
        const app = createApp({
            isShuttingDown: () => true,
            handleProviderAccountUsageAdoption,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/provider-account-usage-adoption',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    adoption,
                },
            });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'daemon_shutting_down',
            });
            expect(handleProviderAccountUsageAdoption).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

});

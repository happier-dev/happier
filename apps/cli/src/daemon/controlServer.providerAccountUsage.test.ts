import {
    SPAWN_SESSION_ERROR_CODES,
    buildProviderAccountUsageRecordId,
    projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
    type ProviderAccountUsageAdoptionV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

function createApp(overrides: Partial<Parameters<typeof createDaemonControlApp>[0]> = {}) {
    return createDaemonControlApp({
        getChildren: () => [],
        machineId: 'machine',
        stopSession: async () => false,
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
        aliases: [{
            kind: 'connectedServiceProfile',
            providerId: 'codex',
            serviceId: 'openai-codex',
            profileId: 'work',
            accountSubjectId: 'acct_123',
        }],
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
        aliases: [{
            kind: 'appServerNative',
            providerId: 'codex',
            accountSubjectId: stableRecordKey.accountSubjectId,
        }],
    };
}

describe('createDaemonControlApp provider account usage routes', () => {
    it('dispatches canonical provider account usage snapshots to the daemon handler', async () => {
        const snapshot = createSnapshot();
        const handleProviderAccountUsageSnapshot = vi.fn(async () => ({ status: 'recorded', recordId: snapshot.recordId }));
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
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: { status: 'recorded', recordId: snapshot.recordId },
            });
            expect(handleProviderAccountUsageSnapshot).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                snapshot,
            });
        } finally {
            await app.close();
        }
    });

    it('projects legacy connected-service quota reports through the canonical provider account usage handler', async () => {
        const snapshot = createSnapshot();
        const projected = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
            snapshot,
            serviceId: 'openai-codex',
            profileId: 'work',
        });
        expect(projected).not.toBeNull();
        const handleProviderAccountUsageSnapshot = vi.fn(async () => ({ status: 'recorded', recordId: snapshot.recordId }));
        const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({ status: 'runtime_projected' }));
        const app = createApp({
            handleProviderAccountUsageSnapshot,
            handleConnectedServiceQuotaSnapshot,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-quota-snapshot',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    serviceId: 'openai-codex',
                    snapshot: projected,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(handleProviderAccountUsageSnapshot).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                snapshot: expect.objectContaining({
                    providerId: 'codex',
                    aliases: expect.arrayContaining([
                        expect.objectContaining({
                            kind: 'connectedServiceProfile',
                            serviceId: 'openai-codex',
                            profileId: 'work',
                        }),
                    ]),
                }),
            });
            expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                snapshot: expect.objectContaining({
                    serviceId: 'openai-codex',
                    profileId: 'work',
                }),
            });
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

    it('rejects mismatched connected-service quota reports before canonical projection', async () => {
        const snapshot = createSnapshot();
        const projected = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
            snapshot,
            serviceId: 'openai-codex',
            profileId: 'work',
        });
        expect(projected).not.toBeNull();
        const handleProviderAccountUsageSnapshot = vi.fn(async () => ({ status: 'recorded', recordId: snapshot.recordId }));
        const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({ status: 'runtime_projected' }));
        const app = createApp({
            handleProviderAccountUsageSnapshot,
            handleConnectedServiceQuotaSnapshot,
        } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-quota-snapshot',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    serviceId: 'openai',
                    snapshot: projected,
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'connected_service_quota_snapshot_service_id_mismatch',
            });
            expect(handleProviderAccountUsageSnapshot).not.toHaveBeenCalled();
            expect(handleConnectedServiceQuotaSnapshot).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });
});

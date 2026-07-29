import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
const activeServerState = vi.hoisted(() => ({
    current: {
        serverId: 'server-1',
        serverUrl: 'https://server-1.example.test',
        generation: 1,
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerState.current,
}));

const SECRET_BEARING_ERROR = [
    'POST https://admin:secret@custom.example.test:9443/path?token=abc#frag failed',
    'Authorization: Bearer very-secret-token',
].join(' ');

describe('connectedServiceQuotaRecoveryCredits ops', () => {
    beforeEach(() => {
        machineRpcWithServerScope.mockReset();
        activeServerState.current = {
            serverId: 'server-1',
            serverUrl: 'https://server-1.example.test',
            generation: 1,
        };
    });

    it('refuses recovery-credit issuance after the admitted server generation changes', async () => {
        let issued = false;
        machineRpcWithServerScope.mockImplementationOnce(async (
            input: Readonly<{ onIssued?: () => void }>,
        ) => {
            input.onIssued?.();
            issued = true;
            return {
                ok: true,
                receipt: {
                    idempotencyKey: 'receipt-key',
                    status: 'consumed',
                },
                snapshot: null,
            };
        });
        activeServerState.current = {
            ...activeServerState.current,
            generation: 8,
        };
        const { connectedServiceQuotaRecoveryCreditConsume } = await import(
            './connectedServiceQuotaRecoveryCredits'
        );

        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serverId: 'server-1',
            expectedActiveServer: {
                serverId: 'server-1',
                generation: 7,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
            providerCreditId: 'credit-1',
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'machine_rpc_failed',
        });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(issued).toBe(false);
    });

    it('consumes a profile recovery credit through server-scoped machine RPC', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            ok: true,
            receipt: {
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:credit:credit-1',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'work',
                fetchedAt: 1_000,
                staleAfterMs: 300_000,
                planLabel: null,
                accountLabel: null,
                meters: [],
            },
        });
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');

        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serverId: 'server-1',
            serviceId: 'openai-codex',
            profileId: 'work',
            providerCreditId: 'credit-1',
        });

        expect(result.ok).toBe(true);
        expect(machineRpcWithServerScope).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
            payload: {
                serviceId: 'openai-codex',
                profileId: 'work',
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:credit:credit-1',
                providerCreditId: 'credit-1',
            },
        });
    });

    it('owns request idempotency for aggregate reset credits at the operation boundary', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            ok: true,
            receipt: {
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:aggregate:1000',
                status: 'consumed',
            },
            snapshot: null,
        });
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');

        await connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serverId: 'server-1',
            serviceId: 'openai-codex',
            profileId: 'work',
            sourceSnapshotFetchedAtMs: 1_000,
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:aggregate:1000',
            }),
        }));
    });

    it('keeps aggregate idempotency stable per snapshot but distinct for later snapshots', async () => {
        const { buildConnectedServiceQuotaRecoveryCreditIdempotencyKey } = await import('./connectedServiceQuotaRecoveryCredits');

        const first = buildConnectedServiceQuotaRecoveryCreditIdempotencyKey({
            surface: 'session-view',
            sessionId: 's1',
            serviceId: 'openai-codex',
            profileId: 'work',
            snapshotFetchedAtMs: 1_000,
        });
        const firstRetry = buildConnectedServiceQuotaRecoveryCreditIdempotencyKey({
            surface: 'session-view',
            sessionId: 's1',
            serviceId: 'openai-codex',
            profileId: 'work',
            snapshotFetchedAtMs: 1_000,
        });
        const laterSnapshot = buildConnectedServiceQuotaRecoveryCreditIdempotencyKey({
            surface: 'session-view',
            sessionId: 's1',
            serviceId: 'openai-codex',
            profileId: 'work',
            snapshotFetchedAtMs: 2_000,
        });

        expect(firstRetry).toBe(first);
        expect(laterSnapshot).not.toBe(first);
        expect(first).toContain('aggregate:1000');
    });

    it('keeps provider-credit idempotency semantic across UI surfaces and sessions', async () => {
        const { buildConnectedServiceQuotaRecoveryCreditIdempotencyKey } = await import('./connectedServiceQuotaRecoveryCredits');

        const fromSessionBanner = buildConnectedServiceQuotaRecoveryCreditIdempotencyKey({
            surface: 'session-view',
            sessionId: 'session-a',
            serviceId: 'openai-codex',
            profileId: 'work',
            providerCreditId: 'credit-1',
            snapshotFetchedAtMs: 1_000,
        });
        const fromSettings = buildConnectedServiceQuotaRecoveryCreditIdempotencyKey({
            surface: 'settings-account-card',
            sessionId: null,
            serviceId: 'openai-codex',
            profileId: 'work',
            providerCreditId: 'credit-1',
            snapshotFetchedAtMs: 2_000,
        });

        expect(fromSettings).toBe(fromSessionBanner);
        expect(fromSessionBanner).toBe('connected-service-quota-recovery-credit:v1:openai-codex:work:credit:credit-1');
    });

    it('fails closed before dispatching invalid profile requests', async () => {
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');

        await expect(connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serviceId: 'openai-codex',
            profileId: '',
        })).resolves.toEqual({
            ok: false,
            error: 'invalid_parameters',
            errorCode: 'invalid_parameters',
        });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('trims provider credit identifiers before building the request key', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({ ok: true, receipt: null, snapshot: null });
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');

        await connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serviceId: 'openai-codex',
            profileId: ' work ',
            providerCreditId: ' credit-1 ',
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                profileId: 'work',
                providerCreditId: 'credit-1',
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:credit:credit-1',
            }),
        }));
    });

    it('sanitizes secret-bearing machine RPC exceptions before returning failure errors', async () => {
        machineRpcWithServerScope.mockRejectedValueOnce(new Error(SECRET_BEARING_ERROR));
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');

        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serviceId: 'openai-codex',
            profileId: 'work',
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'machine_rpc_failed',
        });
        expect(result.error).toContain('https://custom.example.test:9443/path');
        expect(result.error).toContain('Authorization: Bearer [REDACTED]');
        expect(result.error).not.toContain('admin:secret@');
        expect(result.error).not.toContain('?token=abc');
        expect(result.error).not.toContain('#frag');
        expect(result.error).not.toContain('very-secret-token');
    });

    it('sanitizes parsed recovery-credit failure response errors while preserving errorCode', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_rejected',
            error: SECRET_BEARING_ERROR,
            receipt: { idempotencyKey: 'timeout-key', status: 'unknown_after_timeout' },
        });
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');

        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serviceId: 'openai-codex',
            profileId: 'work',
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'provider_rejected',
            receipt: { idempotencyKey: 'timeout-key', status: 'unknown_after_timeout' },
        });
        expect(result.error).toContain('https://custom.example.test:9443/path');
        expect(result.error).toContain('Authorization: Bearer [REDACTED]');
        expect(result.error).not.toContain('admin:secret@');
        expect(result.error).not.toContain('?token=abc');
        expect(result.error).not.toContain('#frag');
        expect(result.error).not.toContain('very-secret-token');
    });
});

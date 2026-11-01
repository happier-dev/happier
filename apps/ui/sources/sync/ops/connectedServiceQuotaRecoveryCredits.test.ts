import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const SECRET_BEARING_ERROR =
    'request failed: https://admin:secret@custom.example.test:9443/path/?token=abc#frag (Authorization: Bearer very-secret-token)';

describe('connectedServiceQuotaRecoveryCredits ops', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('consumes a profile recovery credit through server-scoped machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            receipt: {
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:credit-observation:["credit-1",1000]',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'work',
                fetchedAt: 1_000,
                staleAfterMs: 300_000,
                planLabel: 'Plus',
                accountLabel: 'work@example.com',
                source: 'provider_api',
                confidence: 'exact',
                evidence: { kind: 'provider_api', observedAtMs: 1_000 },
                meters: [],
            },
        });

        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');
        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serverId: 'server-1',
            serviceId: 'openai-codex',
            profileId: ' work ',
            providerCreditId: ' credit-1 ',
            sourceSnapshotFetchedAtMs: 1_000,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
            payload: {
                serviceId: 'openai-codex',
                profileId: 'work',
                providerCreditId: 'credit-1',
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:credit-observation:["credit-1",1000]',
            },
        });
        expect(result).toEqual({
            ok: true,
            receipt: {
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:credit-observation:["credit-1",1000]',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
            snapshot: expect.objectContaining({
                serviceId: 'openai-codex',
                profileId: 'work',
            }),
        });
    });

    it('uses the canonical aggregate idempotency selector when no provider credit id is present', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
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

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                idempotencyKey: 'connected-service-quota-recovery-credit:v1:openai-codex:work:aggregate:1000',
            }),
        }));
    });

    it('fails closed for invalid input and unsupported responses', async () => {
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('./connectedServiceQuotaRecoveryCredits');

        await expect(connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serviceId: 'openai-codex',
            profileId: '',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });

        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });
        await expect(connectedServiceQuotaRecoveryCreditConsume({
            machineId: 'machine-1',
            serviceId: 'openai-codex',
            profileId: 'work',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_response',
            error: 'unsupported_response',
        });
    });

    it('sanitizes secret-bearing machine RPC exceptions before returning failure errors', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error(SECRET_BEARING_ERROR));

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
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
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

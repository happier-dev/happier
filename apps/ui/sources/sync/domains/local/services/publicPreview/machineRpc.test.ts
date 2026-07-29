import type {
    DaemonLocalServicePublicPreviewCreateResponseV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

const exposure = {
    exposureId: 'public_preview_1',
    previewId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'secret_link',
    state: 'active',
    publicUrl: 'https://preview.example.test/s/public_preview_1',
    issuedAt: 1_000,
    expiresAt: 601_000,
    auditEventIds: ['audit_1'],
    rateLimitProfileId: 'default',
} satisfies LocalServicePublicExposureV1;

const snapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    previewId: 'preview_1',
    generatedAt: 2_000,
    refreshState: 'idle',
    policy: {
        enabled: true,
        allowedModes: ['secret_link'],
        maxTtlMs: 600_000,
        maxConcurrentExposures: 1,
        dnsTlsRequired: true,
        auditRequired: true,
        rateLimitProfileIds: ['default'],
    },
    exposures: [exposure],
    diagnostics: [],
} satisfies LocalServicePublicPreviewSnapshotV1;

describe('local service public-preview machine RPC client', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('fetches public preview status through daemon machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ protocolVersion: 1, snapshot });
        const { fetchLocalServicePublicPreviewStatusViaMachineRpc } = await import('./machineRpc');

        await expect(fetchLocalServicePublicPreviewStatusViaMachineRpc({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
            serverId: 'server_1',
        })).resolves.toEqual({ ok: true, snapshot });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
            payload: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
        });
    });

    it('creates, revokes, and copies bound public preview exposures through daemon machine RPC', async () => {
        const createResponse = {
            protocolVersion: 1,
            exposure,
            snapshot,
        } satisfies DaemonLocalServicePublicPreviewCreateResponseV1;
        const revokeResponse = {
            protocolVersion: 1 as const,
            exposureId: 'public_preview_1',
            revokedAt: 3_000,
            snapshot: {
                ...snapshot,
                exposures: [{ ...exposure, state: 'revoked' as const, revokedAt: 3_000 }],
            },
        };
        const copyUrlResponse = {
            protocolVersion: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: exposure.publicUrl,
        };
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce(createResponse)
            .mockResolvedValueOnce(revokeResponse)
            .mockResolvedValueOnce(copyUrlResponse);
        const {
            copyLocalServicePublicPreviewUrlViaMachineRpc,
            createLocalServicePublicPreviewExposureViaMachineRpc,
            revokeLocalServicePublicPreviewExposureViaMachineRpc,
        } = await import('./machineRpc');

        await expect(createLocalServicePublicPreviewExposureViaMachineRpc({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
                rateLimitProfileId: 'default',
            },
            serverId: 'server_1',
        })).resolves.toEqual({ ok: true, response: createResponse });
        await expect(revokeLocalServicePublicPreviewExposureViaMachineRpc({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            serverId: 'server_1',
        })).resolves.toEqual({ ok: true, response: revokeResponse });
        await expect(copyLocalServicePublicPreviewUrlViaMachineRpc({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            serverId: 'server_1',
        })).resolves.toEqual({ ok: true, response: copyUrlResponse });

        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toEqual([
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
        ]);
    });

    it('fails closed for unavailable and mismatched public preview responses', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                exposure: { ...exposure, machineId: 'machine_2' },
                snapshot,
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_2',
                publicUrl: exposure.publicUrl,
            });
        const {
            copyLocalServicePublicPreviewUrlViaMachineRpc,
            createLocalServicePublicPreviewExposureViaMachineRpc,
            fetchLocalServicePublicPreviewStatusViaMachineRpc,
        } = await import('./machineRpc');

        await expect(fetchLocalServicePublicPreviewStatusViaMachineRpc({
            request: { machineId: 'machine_1' },
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(createLocalServicePublicPreviewExposureViaMachineRpc({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
            },
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
        await expect(copyLocalServicePublicPreviewUrlViaMachineRpc({
            request: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });
});

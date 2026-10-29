import type {
    DaemonLocalServicePublicPreviewCreateResponseV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

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

async function publicOperations(serverId = 'server_1') {
    const client = await import('./machineRpc');
    const binding = { machineId: 'machine_1', sessionId: 'session_1', previewId: 'preview_1', exposureId: 'public_preview_1' };
    return [
        () => client.fetchLocalServicePublicPreviewStatusViaMachineRpc({ serverId, request: { machineId: binding.machineId } }),
        () => client.createLocalServicePublicPreviewExposureViaMachineRpc({ serverId, request: {
            machineId: binding.machineId, sessionId: binding.sessionId, previewId: binding.previewId,
            mode: 'secret_link', ttlMs: 600_000,
        } }),
        () => client.revokeLocalServicePublicPreviewExposureViaMachineRpc({ serverId, request: binding }),
        () => client.copyLocalServicePublicPreviewUrlViaMachineRpc({ serverId, request: binding }),
    ];
}

describe('local service public-preview machine RPC client', () => {
    beforeEach(() => {
        const observation = { status: 'ready' as const,
            features: createRootLayoutFeaturesResponse({ features: { localServices: { publicPreview: { enabled: true } } } }),
        };
        primeServerFeaturesSnapshot({ serverId: 'server_1', snapshot: observation });
        primeServerFeaturesSnapshot({ snapshot: observation });
    });
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        resetServerFeaturesClientForTests();
    });

    it.each(['disabled', 'missing', 'malformed'] as const)('refuses public status without issuing an RPC when the exact Home bit is %s', async kind => {
        const features = createRootLayoutFeaturesResponse({ features: { localServices: { publicPreview: { enabled: false } } } });
        // Public feature discovery is an untrusted network boundary; malformed/older payloads must fail closed.
        if (kind === 'missing') Reflect.deleteProperty(features.features.localServices, 'publicPreview');
        if (kind === 'malformed') Reflect.set(features.features.localServices.publicPreview, 'enabled', 'true');
        primeServerFeaturesSnapshot({ serverId: 'disabled_home', snapshot: { status: 'ready', features } });
        machineRpcWithServerScopeMock.mockResolvedValue({ protocolVersion: 1, snapshot });
        for (const operation of await publicOperations('disabled_home')) {
            await expect(operation()).resolves.toEqual({ ok: false, reason: 'feature_disabled' });
        }
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it.each(['throw', 'result'] as const)('preserves a server-policy refusal after a stale enabled observation (%s)', async carrier => {
        if (carrier === 'throw') machineRpcWithServerScopeMock.mockRejectedValue({ rpcErrorCode: 'public_preview_disabled' });
        else machineRpcWithServerScopeMock.mockResolvedValue({ errorCode: 'public_preview_disabled', error: 'public_preview_disabled' });
        for (const operation of await publicOperations()) {
            await expect(operation()).resolves.toEqual({ ok: false, reason: 'feature_disabled' });
        }
    });

    it.each([{ error: 'HTTP request failed' }, { error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN },
        { error: 'session_not_authorized', errorCode: 'session_not_authorized' }])('recognizes refusal envelopes before success parsing: %j', async refusal => {
        machineRpcWithServerScopeMock.mockResolvedValue(refusal);
        for (const operation of await publicOperations()) {
            await expect(operation()).resolves.toEqual({ ok: false, reason: 'request_failed' });
        }
    });

    it.each(['throw', 'result'] as const)('keeps temporary routing loss distinct from an unsupported public preview (%s)', async carrier => {
        const { fetchLocalServicePublicPreviewStatusViaMachineRpc } = await import('./machineRpc');
        const input = { serverId: 'server_1', request: { machineId: 'machine_1', sessionId: 'session_1', previewId: 'preview_1' } };
        if (carrier === 'throw') machineRpcWithServerScopeMock.mockRejectedValueOnce({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        else machineRpcWithServerScopeMock.mockResolvedValueOnce({ errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'Method not found' });
        expect(await fetchLocalServicePublicPreviewStatusViaMachineRpc(input)).toEqual({ ok: false, reason: 'request_failed' });
        machineRpcWithServerScopeMock.mockRejectedValueOnce({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        expect(await fetchLocalServicePublicPreviewStatusViaMachineRpc(input)).toEqual({ ok: false, reason: 'unavailable' });
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

    it('keeps the enabled Machine-only empty-snapshot path reachable', async () => {
        const machineSnapshot = { ...snapshot, sessionId: undefined, previewId: undefined, exposures: [] };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ protocolVersion: 1, snapshot: machineSnapshot });
        const { fetchLocalServicePublicPreviewStatusViaMachineRpc } = await import('./machineRpc');
        await expect(fetchLocalServicePublicPreviewStatusViaMachineRpc({ serverId: 'server_1', request: { machineId: 'machine_1' } }))
            .resolves.toEqual({ ok: true, snapshot: machineSnapshot });
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
            serverId: 'server_1',
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

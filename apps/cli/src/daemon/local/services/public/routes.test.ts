import { describe, expect, it, vi } from 'vitest';

import type { LocalServicePublicExposureV1, LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

import { createLocalServicePublicPreviewServerRoutes } from './routes';
import { DaemonLocalServicePublicPreviewCreateRequestV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import type { RpcHandlerContext } from '@/api/rpc/types';

const exposure: LocalServicePublicExposureV1 = {
    exposureId: 'public_preview_1',
    previewId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'secret_link',
    state: 'active',
    publicUrl: 'https://preview.happier.test/v1/local-services/public/public_preview_1?publicToken=token_1',
    issuedAt: 1_000,
    expiresAt: 61_000,
    auditEventIds: ['audit_create_1'],
    rateLimitProfileId: 'default',
};

const snapshot: LocalServicePublicPreviewSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    previewId: 'preview_1',
    generatedAt: 2_000,
    refreshState: 'idle',
    policy: {
        enabled: true,
        allowedModes: ['secret_link'],
        maxTtlMs: 60_000,
        dnsTlsRequired: false,
        auditRequired: true,
        rateLimitProfileIds: [],
    },
    exposures: [exposure],
    diagnostics: [],
};

describe('createLocalServicePublicPreviewServerRoutes', () => {
    it('refuses foreign Machine actors before reading or mutating with the custodian credential', async () => {
        let httpReached = false;
        const input = { accountId: 'custodian', token: 'custodian-token', serverBaseUrl: 'https://home.example.test', http: {
            async post() { httpReached = true; return { data: { protocolVersion: 1, snapshot } }; },
            async delete() { httpReached = true; return { data: { ok: true } }; },
        } };
        const routes = createLocalServicePublicPreviewServerRoutes(input);
        const context: RpcHandlerContext = { signal: new AbortController().signal, machineAdmission: {
            actorAccountId: 'foreign-viewer', custodianAccountId: 'custodian', machineId: exposure.machineId,
            installationId: 'installation-1', role: 'use', encryptionMode: 'plain' } };
        await expect(routes.getStatus({ machineId: exposure.machineId, sessionId: exposure.sessionId }, context))
            .rejects.toThrow('requester_credentials_unavailable');
        await expect(routes.copyUrl({ machineId: exposure.machineId, sessionId: exposure.sessionId,
            previewId: exposure.previewId, exposureId: exposure.exposureId }, context)).rejects.toThrow('requester_credentials_unavailable');
        await expect(routes.revokeExposure({ machineId: exposure.machineId, sessionId: exposure.sessionId,
            previewId: exposure.previewId, exposureId: exposure.exposureId }, context)).rejects.toThrow('requester_credentials_unavailable');
        expect(httpReached).toBe(false);
        const ownContext: RpcHandlerContext = { ...context,
            machineAdmission: { ...context.machineAdmission!, actorAccountId: 'custodian' },
            verifyMachineAdmissionCurrent: async () => true };
        await expect(routes.getStatus({ machineId: exposure.machineId, sessionId: exposure.sessionId }, ownContext))
            .resolves.toEqual(snapshot);
        httpReached = false;
        await expect(routes.getStatus({ machineId: exposure.machineId, sessionId: exposure.sessionId },
            { ...ownContext, verifyMachineAdmissionCurrent: async () => false }))
            .rejects.toThrow('requester_credentials_unavailable');
        expect(httpReached).toBe(false);
    });
    it('transports the actual sessionless service binding and copies only its server-returned public URL', async () => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: exposure.machineId, managedServiceId: 'instance_1', cwd: '/workspace/app',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } };
        const nativeExposure = { ...exposure, sessionId: undefined, serviceTarget };
        const nativeSnapshot = { ...snapshot, sessionId: undefined, exposures: [nativeExposure] };
        let responseExposure = nativeExposure;
        const routes = createLocalServicePublicPreviewServerRoutes({ token: 'token_1', serverBaseUrl: 'https://app.happier.test', http: {
            async post(url, body) {
                if (url.endsWith('/status')) return { data: { protocolVersion: 1, snapshot: nativeSnapshot } };
                // The HTTP peer enforces the real wire schema, not an internal daemon implementation.
                DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse(body);
                return { data: { exposure: responseExposure } };
            }, async delete() { return { data: { ok: true } }; },
        } });
        const request = { machineId: nativeExposure.machineId, previewId: nativeExposure.previewId, serviceTarget,
            mode: 'secret_link' as const, ttlMs: 60_000, confirmation: { acknowledged: true as const } };
        await expect(routes.createExposure(request)).resolves.toMatchObject({ exposure: nativeExposure });
        await expect(routes.copyUrl({ machineId: request.machineId, previewId: request.previewId,
            serviceTarget, exposureId: nativeExposure.exposureId })).resolves.toMatchObject({ publicUrl: nativeExposure.publicUrl, serviceTarget });
        responseExposure = { ...nativeExposure, serviceTarget: { ...serviceTarget, managedServiceId: 'another_instance' } };
        await expect(routes.createExposure(request)).rejects.toThrow('local_services_public_preview_binding_mismatch');
    });
    it('loads status through the authenticated server status route', async () => {
        const post = vi.fn(async () => ({
            data: {
                protocolVersion: 1,
                snapshot,
            },
        }));
        const routes = createLocalServicePublicPreviewServerRoutes({
            token: 'token_1',
            serverBaseUrl: 'https://app.happier.test',
            http: {
                post,
                delete: vi.fn(),
            },
        });

        await expect(routes.getStatus({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
        })).resolves.toEqual(snapshot);

        expect(post).toHaveBeenCalledWith(
            'https://app.happier.test/v1/local-services/public/status',
            {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
            {
                headers: {
                    Authorization: 'Bearer token_1',
                    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                },
            },
        );
    });

    it('creates, revokes, and copies only machine/session/preview-bound exposures', async () => {
        const revokedExposure: LocalServicePublicExposureV1 = {
            ...exposure,
            state: 'revoked',
            revokedAt: 3_000,
            auditEventIds: ['audit_create_1', 'audit_revoke_1'],
        };
        const post = vi.fn(async (url: string) => {
            if (url.endsWith('/status')) {
                return {
                    data: {
                        protocolVersion: 1,
                        snapshot,
                    },
                };
            }
            return { data: { exposure } };
        });
        const deleteRequest = vi.fn(async () => ({ data: { ok: true } }));
        const routes = createLocalServicePublicPreviewServerRoutes({
            token: 'token_1',
            serverBaseUrl: 'https://app.happier.test/',
            http: {
                post,
                delete: deleteRequest,
            },
        });

        await expect(routes.createExposure({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            mode: 'secret_link',
            ttlMs: 60_000,
            rateLimitProfileId: 'default',
            confirmation: { acknowledged: true },
        })).resolves.toEqual({
            protocolVersion: 1,
            exposure,
            snapshot,
        });
        expect(post).toHaveBeenCalledWith(
            'https://app.happier.test/v1/local-services/public',
            {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 60_000,
                rateLimitProfileId: 'default',
                confirmation: { acknowledged: true },
            },
            {
                headers: {
                    Authorization: 'Bearer token_1',
                    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                },
            },
        );

        post.mockResolvedValueOnce({
            data: {
                protocolVersion: 1,
                snapshot: {
                    ...snapshot,
                    exposures: [revokedExposure],
                },
            },
        });
        await expect(routes.revokeExposure({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            exposureId: 'public_preview_1',
            revokedAt: 3_000,
            snapshot: {
                ...snapshot,
                exposures: [revokedExposure],
            },
        });
        expect(deleteRequest).toHaveBeenCalledWith(
            'https://app.happier.test/v1/local-services/public/public_preview_1',
            {
                headers: {
                    Authorization: 'Bearer token_1',
                    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                },
                data: {
                    machineId: 'machine_1',
                    sessionId: 'session_1',
                    previewId: 'preview_1',
                    exposureId: 'public_preview_1',
                },
            },
        );

        await expect(routes.copyUrl({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: exposure.publicUrl,
        });
    });

    it('rejects status snapshots that do not bind to the daemon request', async () => {
        const post = vi.fn(async () => ({
            data: {
                protocolVersion: 1,
                snapshot: {
                    ...snapshot,
                    machineId: 'machine_2',
                    exposures: [{ ...exposure, machineId: 'machine_2' }],
                },
            },
        }));
        const routes = createLocalServicePublicPreviewServerRoutes({
            token: 'token_1',
            serverBaseUrl: 'https://app.happier.test',
            http: {
                post,
                delete: vi.fn(),
            },
        });

        await expect(routes.getStatus({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
        })).rejects.toThrow('local_services_public_preview_status_binding_mismatch');
    });

    it('refuses to copy stale or unconfirmed public preview URLs', async () => {
        const post = vi.fn(async () => ({
            data: {
                protocolVersion: 1,
                snapshot: {
                    ...snapshot,
                    generatedAt: exposure.expiresAt,
                    refreshState: 'error',
                    exposures: [exposure],
                },
            },
        }));
        const routes = createLocalServicePublicPreviewServerRoutes({
            token: 'token_1',
            serverBaseUrl: 'https://app.happier.test',
            http: {
                post,
                delete: vi.fn(),
            },
        });

        await expect(routes.copyUrl({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
        })).rejects.toThrow('local_services_public_preview_exposure_unavailable');
    });
});

import { describe, expect, it, vi } from 'vitest';

import type { LocalServicePublicExposureV1, LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol';

import { createLocalServicePublicPreviewServerRoutes } from './routes';

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
                headers: { Authorization: 'Bearer token_1' },
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
                headers: { Authorization: 'Bearer token_1' },
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
                headers: { Authorization: 'Bearer token_1' },
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

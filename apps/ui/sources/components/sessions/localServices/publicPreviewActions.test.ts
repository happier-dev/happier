import { describe, expect, it, vi } from 'vitest';

import type {
    LocalServiceLaunchTargetV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';

const target = {
    id: 'preview:preview_1',
    source: 'registered_preview',
    machineId: 'machine_1',
    sessionId: 'session_1',
    title: 'Dashboard',
    confidence: 'high',
    state: 'available',
    actions: [],
    browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
    },
} satisfies LocalServiceLaunchTargetV1;

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

describe('local service public preview actions', () => {
    it('creates a public preview for daemon-backed local preview targets through the runtime executor', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1 as const,
            exposure,
            snapshot,
        }));
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');

        const actions = createLocalServicePublicPreviewActions({
            runtimeActionExecute,
            machineId: 'machine_1',
            sessionId: 'session_1',
            serverId: 'server_1',
        });

        await expect(actions.create(target)).resolves.toEqual(expect.objectContaining({
            exposure,
        }));
        expect(runtimeActionExecute).toHaveBeenCalledWith({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
                // UX-5: the create request carries the daemon-required consent acknowledgement.
                confirmation: { acknowledged: true },
            },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
                surface: 'ui',
            },
        });
    });

    it('copies a bound public preview URL only after daemon validation succeeds', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: exposure.publicUrl,
        }));
        const copyToClipboard = vi.fn(async () => true);
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');

        const actions = createLocalServicePublicPreviewActions({
            runtimeActionExecute,
            machineId: 'machine_1',
            sessionId: 'session_1',
            serverId: 'server_1',
            copyToClipboard,
        });

        await expect(actions.copyUrl(exposure)).resolves.toBe(true);
        expect(runtimeActionExecute).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'localServices.publicPreview.copyUrl',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
        }));
        expect(copyToClipboard).toHaveBeenCalledWith(exposure.publicUrl);
    });

    it('revokes a public preview through the runtime executor', async () => {
        const revokedSnapshot = {
            ...snapshot,
            exposures: [{ ...exposure, state: 'revoked' as const, revokedAt: 3_000 }],
        };
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1 as const,
            exposureId: 'public_preview_1',
            revokedAt: 3_000,
            snapshot: revokedSnapshot,
        }));
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');

        const actions = createLocalServicePublicPreviewActions({
            runtimeActionExecute,
            machineId: 'machine_1',
            sessionId: 'session_1',
        });

        await expect(actions.revoke(exposure)).resolves.toEqual(expect.objectContaining({
            exposureId: 'public_preview_1',
        }));
    });
});

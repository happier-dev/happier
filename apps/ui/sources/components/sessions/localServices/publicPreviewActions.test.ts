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
    it('does not create a public exposure for a stale qualified row from another Home', async () => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: 'machine_1', managedServiceId: 'actual-instance',
            workspaceId: 'accepted-workspace', cwd: '/accepted/web',
            declaration: { workspaceRefId: 'accepted-workspace', selection: { kind: 'manifest' as const, name: 'web' } } };
        const qualifiedTarget = { ...target, sessionId: undefined,
            workspace: { serverId: 'home-a', machineId: 'machine_1', workspaceId: 'accepted-workspace', rootPath: '/accepted' },
            browserTarget: { kind: 'localServicePreview' as const, targetId: 'preview_1', machineId: 'machine_1', serviceTarget },
        } satisfies LocalServiceLaunchTargetV1;
        const requests: Parameters<import('@happier-dev/protocol').RuntimeActionExecute>[0][] = [];
        const runtimeActionExecute: import('@happier-dev/protocol').RuntimeActionExecute = async request => {
            requests.push(request);
            return { ok: false, errorCode: 'approval_required', error: 'approval_required' };
        };
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');
        const actions = createLocalServicePublicPreviewActions({ runtimeActionExecute, serverId: 'home-b' });
        expect(await actions.create(qualifiedTarget)).toBeUndefined();
        expect(requests).toEqual([]);
    });

    it('creates, copies and revokes a sessionless preview using its exact service binding', async () => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: 'machine_1', managedServiceId: 'actual-instance',
            workspaceId: 'accepted-workspace', cwd: '/accepted/web',
            declaration: { workspaceRefId: 'accepted-workspace', selection: { kind: 'manifest' as const, name: 'web' } } };
        const { sessionId: _sessionId, ...baseExposure } = exposure;
        const serviceExposure = { ...baseExposure, serviceTarget } satisfies LocalServicePublicExposureV1;
        const { sessionId: _snapshotSessionId, ...baseSnapshot } = snapshot;
        const serviceSnapshot = { ...baseSnapshot, exposures: [serviceExposure] } satisfies LocalServicePublicPreviewSnapshotV1;
        const requests: Parameters<import('@happier-dev/protocol').RuntimeActionExecute>[0][] = [];
        // The remote Action receipts and OS clipboard are system boundaries; projection stays real.
        const runtimeActionExecute: import('@happier-dev/protocol').RuntimeActionExecute = async request => {
            requests.push(request);
            if (request.actionId === 'localServices.publicPreview.create') return { protocolVersion: 1, exposure: serviceExposure, snapshot: serviceSnapshot };
            if (request.actionId === 'localServices.publicPreview.copyUrl') return { protocolVersion: 1, machineId: 'machine_1', previewId: 'preview_1', exposureId: 'public_preview_1', serviceTarget, publicUrl: serviceExposure.publicUrl };
            return { protocolVersion: 1, exposureId: 'public_preview_1', revokedAt: 3_000, snapshot: { ...serviceSnapshot, exposures: [{ ...serviceExposure, state: 'revoked', revokedAt: 3_000 }] } };
        };
        const copyToClipboard = vi.fn(async () => true);
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');
        const actions = createLocalServicePublicPreviewActions({ runtimeActionExecute, serverId: 'server_1', sessionId: 'invoking-session', copyToClipboard });
        const browserTarget = { kind: 'localServicePreview' as const, targetId: 'preview_1', machineId: 'machine_1', serviceTarget };
        await expect(actions.create(browserTarget, { mode: 'secret_link', ttlMs: 900_000 })).resolves.toMatchObject({ exposure: serviceExposure });
        await expect(actions.copyUrl(serviceExposure)).resolves.toBe(true);
        await expect(actions.revoke(serviceExposure)).resolves.toMatchObject({ exposureId: 'public_preview_1' });
        for (const request of requests) {
            expect(request.input).toMatchObject({ machineId: 'machine_1', previewId: 'preview_1', serviceTarget });
            expect(request.input).not.toHaveProperty('sessionId');
        }
        expect(requests[0]!.input).toMatchObject({ ttlMs: 900_000, confirmation: { acknowledged: true } });
        expect(copyToClipboard).toHaveBeenCalledWith(serviceExposure.publicUrl);
    });

    it('refuses a Copy receipt bound to another managed occurrence', async () => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: 'machine_1', managedServiceId: 'actual-instance', cwd: '/accepted/web',
            declaration: { workspaceRefId: 'accepted-workspace', selection: { kind: 'manifest' as const, name: 'web' } } };
        const { sessionId: _sessionId, ...baseExposure } = exposure;
        const serviceExposure = { ...baseExposure, serviceTarget } satisfies LocalServicePublicExposureV1;
        const runtimeActionExecute = vi.fn(async () => ({ protocolVersion: 1, machineId: 'machine_1', previewId: 'preview_1', exposureId: 'public_preview_1',
            serviceTarget: { ...serviceTarget, managedServiceId: 'another-instance' }, publicUrl: exposure.publicUrl }));
        const copyToClipboard = vi.fn(async () => true);
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');
        const actions = createLocalServicePublicPreviewActions({ runtimeActionExecute, copyToClipboard });
        await expect(actions.copyUrl(serviceExposure)).resolves.toBe(false);
        expect(copyToClipboard).not.toHaveBeenCalled();
    });
    it('creates a link directly from a browser preview target through the same action owner', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ protocolVersion: 1 as const, exposure, snapshot }));
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');
        const actions = createLocalServicePublicPreviewActions({ runtimeActionExecute, serverId: 'server_1' });
        await expect(actions.create(target.browserTarget)).resolves.toMatchObject({ exposure });
        expect(runtimeActionExecute).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'localServices.publicPreview.create',
            input: expect.objectContaining({ machineId: 'machine_1', sessionId: 'session_1', previewId: 'preview_1', confirmation: { acknowledged: true } }),
        }));
    });
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

        await expect(actions.create({ ...target, kind: 'http' })).resolves.toEqual(expect.objectContaining({
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

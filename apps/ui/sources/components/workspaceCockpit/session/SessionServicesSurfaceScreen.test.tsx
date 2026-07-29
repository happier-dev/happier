import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureDecision, FeatureId, RuntimeActionExecute } from '@happier-dev/protocol';
import {
    buildLocalServiceInventoryState,
    buildManagedLocalServicesState,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

import { SessionServicesSurfaceScreen } from './SessionServicesSurfaceScreen';

const useFeatureDecisionMock = vi.hoisted(() => vi.fn((featureId: FeatureId, _scope?: unknown): FeatureDecision => ({
    featureId,
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime' },
})));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: FeatureId, scope?: unknown) => useFeatureDecisionMock(featureId, scope),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
        spies: { confirm: modalConfirmMock },
    }).module;
});

function enabledDecision(featureId: FeatureId): FeatureDecision {
    return {
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'runtime' },
    };
}

function disabledServerDecision(featureId: FeatureId): FeatureDecision {
    return {
        featureId,
        state: 'disabled',
        blockedBy: 'server',
        blockerCode: 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'spawn', serverId: 'server-a' },
    };
}

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            id: 'managed:mobile-feed',
            source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'mobile-feed' },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Mobile feed service',
            subtitle: 'localhost:4173',
            confidence: 'medium',
            state: 'available',
            actions: ['start'],
        }],
    });
}

function buildPublicPreviewLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            id: 'preview:mobile-feed',
            source: 'registered_preview',
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Mobile feed preview',
            subtitle: 'localhost:4173',
            confidence: 'high',
            state: 'available',
            actions: [],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-mobile',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        }],
    });
}

function buildPublicPreviewState() {
    return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        generatedAt: 4_000,
        refreshState: 'idle',
        policy: {
            enabled: true,
            allowedModes: ['secret_link'],
            maxTtlMs: 600_000,
            maxConcurrentExposures: 2,
            dnsTlsRequired: true,
            auditRequired: true,
            rateLimitProfileIds: ['default'],
        },
        exposures: [],
        diagnostics: [],
    });
}

describe('SessionServicesSurfaceScreen', () => {
    beforeEach(() => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId): FeatureDecision => enabledDecision(featureId));
        modalConfirmMock.mockClear();
    });

    it('passes supplied local service launcher state into the mobile Services pane', async () => {
        const screen = await renderScreen(
            <SessionServicesSurfaceScreen
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('session-mobile-services-row:managed:mobile-feed')).toBeTruthy();
    });

    it('does not poll public preview status when public previews are disabled', async () => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId): FeatureDecision => (
            featureId === 'localServices.publicPreview'
                ? disabledServerDecision(featureId)
                : enabledDecision(featureId)
        ));
        const publicPreviewStatusClient = vi.fn(async () => ({
            ok: false as const,
            reason: 'unavailable' as const,
        }));

        await renderScreen(
            <SessionServicesSurfaceScreen
                sessionId="session-a"
                serverId="server-a"
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                publicPreviewStatusClient={publicPreviewStatusClient}
            />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(publicPreviewStatusClient).not.toHaveBeenCalled();
    });

    it('builds a launcher start runtime action request for mobile Services Start targets', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:mobile-feed',
            status: 'succeeded',
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                sessionId: 'session-a',
                updatedAt: 4_000,
                targets: [],
            },
        })) satisfies RuntimeActionExecute;
        const screen = await renderScreen(
            <SessionServicesSurfaceScreen
                sessionId="session-a"
                serverId="server-a"
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('session-mobile-services-row:managed:mobile-feed-start'),
            'session-mobile-services-row:managed:mobile-feed-start',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'managed:mobile-feed',
                sessionId: 'session-a',
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('creates public preview links through the mobile Services runtime action host', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            previewId: 'preview-mobile',
            exposureId: 'public-preview-1',
            status: 'created',
            exposure: {
                exposureId: 'public-preview-1',
                previewId: 'preview-mobile',
                sessionId: 'session-a',
                machineId: 'machine-a',
                mode: 'secret_link',
                state: 'active',
                publicUrl: 'https://preview.example.test/public-preview-1',
                issuedAt: 4_000,
                expiresAt: 604_000,
                auditEventIds: ['audit-1'],
                rateLimitProfileId: 'default',
            },
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                sessionId: 'session-a',
                generatedAt: 4_000,
                refreshState: 'idle',
                policy: {
                    enabled: true,
                    allowedModes: ['secret_link'],
                    maxTtlMs: 600_000,
                    maxConcurrentExposures: 2,
                    dnsTlsRequired: true,
                    auditRequired: true,
                    rateLimitProfileIds: ['default'],
                },
                exposures: [],
                diagnostics: [],
            },
        })) satisfies RuntimeActionExecute;
        const screen = await renderScreen(
            <SessionServicesSurfaceScreen
                sessionId="session-a"
                serverId="server-a"
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildPublicPreviewLauncherState()}
                publicPreviewState={buildPublicPreviewState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('session-mobile-services-row:preview:mobile-feed-public-preview-target:preview-mobile-create'),
            'session-mobile-services-row:preview:mobile-feed-public-preview-target:preview-mobile-create',
        );

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: 'preview-mobile',
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });
});

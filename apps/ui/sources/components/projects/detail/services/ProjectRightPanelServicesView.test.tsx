import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureDecision, FeatureId, RuntimeActionExecute } from '@happier-dev/protocol';
import {
    buildLocalServiceInventoryState,
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

import { ProjectRightPanelServicesView } from './ProjectRightPanelServicesView';

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
        updatedAt: 3_000,
        targets: [{
            id: 'inventory:project-feed',
            source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'project-feed' },
            machineId: 'machine-a',
            title: 'Project feed service',
            subtitle: 'localhost:3000',
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
            id: 'preview:project-feed',
            source: 'registered_preview',
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Project feed preview',
            subtitle: 'localhost:3000',
            confidence: 'high',
            state: 'available',
            actions: [],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-project',
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

describe('ProjectRightPanelServicesView', () => {
    beforeEach(() => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId): FeatureDecision => ({
            featureId,
            state: 'enabled',
            blockedBy: null,
            blockerCode: 'none',
            diagnostics: [],
            evaluatedAt: 1,
            scope: { scopeKind: 'runtime' },
        }));
        modalConfirmMock.mockClear();
    });

    it('passes supplied local service launcher state into the Services pane', async () => {
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('does not poll public preview status when public previews are disabled', async () => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId): FeatureDecision => (
            featureId === 'localServices.publicPreview'
                ? disabledServerDecision(featureId)
                : {
                    featureId,
                    state: 'enabled',
                    blockedBy: null,
                    blockerCode: 'none',
                    diagnostics: [],
                    evaluatedAt: 1,
                    scope: { scopeKind: 'runtime' },
                }
        ));
        const publicPreviewStatusClient = vi.fn(async () => ({
            ok: false as const,
            reason: 'unavailable' as const,
        }));

        await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId="server-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                publicPreviewStatusClient={publicPreviewStatusClient}
            />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(publicPreviewStatusClient).not.toHaveBeenCalled();
    });

    it('builds a launcher start runtime action request without requiring session context', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'inventory:project-feed',
            status: 'succeeded',
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 4_000,
                targets: [],
            },
        })) satisfies RuntimeActionExecute;
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId="server-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('project-rightpanel-services-row:inventory:project-feed-start'),
            'project-rightpanel-services-row:inventory:project-feed-start',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'inventory:project-feed',
            },
            context: {
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('creates public preview links through the project Services runtime action host', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            previewId: 'preview-project',
            exposureId: 'public-preview-1',
            status: 'created',
            exposure: {
                exposureId: 'public-preview-1',
                previewId: 'preview-project',
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
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId="server-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildPublicPreviewLauncherState()}
                publicPreviewState={buildPublicPreviewState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('project-rightpanel-services-row:preview:project-feed-public-preview-target:preview-project-create'),
            'project-rightpanel-services-row:preview:project-feed-public-preview-target:preview-project-create',
        );

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: 'preview-project',
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
            context: {
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });
});

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureDecision, FeatureId, RuntimeActionExecute } from '@happier-dev/protocol';
import {
    buildLocalServiceInventoryRow,
    buildLocalServiceInventoryState,
    buildManagedLocalServiceRow,
    buildManagedLocalServicesState,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    type LocalServiceLauncherSnapshot,
    type LocalServiceLauncherSnapshotClient,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceManagedSnapshotClient } from '@/sync/domains/local/services/managed/useManagedLocalServicesState';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

import { SessionRightPanelServicesView } from './SessionRightPanelServicesView';

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
            id: 'managed:session-feed',
            source: 'managed_service',
            sourceClass: {
                kind: 'managed_service',
                managedServiceId: 'session-feed',
            },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Session feed preview',
            subtitle: 'localhost:5173',
            kind: 'managed_service',
            confidence: 'high',
            state: 'available',
            actions: ['start'],
        }],
    });
}

function buildManagedLauncherState(serviceId = 'managed-service-1') {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            id: `managed:${serviceId}`,
            source: 'managed_service',
            sourceClass: {
                kind: 'managed_service',
                managedServiceId: serviceId,
            },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Managed service',
            subtitle: 'localhost:5174',
            kind: 'managed_service',
            confidence: 'high',
            state: 'available',
            actions: ['manage'],
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
            id: 'preview:session-feed',
            source: 'registered_preview',
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Session feed preview',
            subtitle: 'localhost:5173',
            confidence: 'high',
            state: 'available',
            actions: ['open_preview'],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-session',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        }],
    });
}

const liveStartSnapshot = {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 3_000,
    targets: [{
        id: 'managed:session-feed',
        source: 'managed_service',
        sourceClass: {
            kind: 'managed_service',
            managedServiceId: 'session-feed',
        },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Session feed preview',
        subtitle: 'localhost:5173',
        kind: 'managed_service',
        confidence: 'high',
        state: 'available',
        actions: ['start'],
    }],
} satisfies LocalServiceLauncherSnapshot;

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

describe('SessionRightPanelServicesView', () => {
    beforeEach(() => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId): FeatureDecision => enabledDecision(featureId));
        modalConfirmMock.mockClear();
    });

    it('passes supplied local service launcher state into the Services pane', async () => {
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('session-rightpanel-services-row:managed:session-feed')).toBeTruthy();
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
            <SessionRightPanelServicesView
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

    it('builds a stop-managed runtime action request for running managed rows', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            v: 1,
            requestId: 'request-managed-service-1',
            action: 'stop_managed',
            status: 'succeeded',
            auditEvents: [],
        })) satisfies RuntimeActionExecute;
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId="server-a"
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({
                    rows: [buildManagedLocalServiceRow({
                        id: 'managed-service-1',
                        phase: 'running',
                        supportedActions: ['stop_managed'],
                    })],
                })}
                launcherState={buildManagedLauncherState('managed-service-1')}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:managed:managed-service-1-stop'),
            'session-rightpanel-services-row:managed:managed-service-1-stop',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.actions.stopManaged',
            input: {
                requestId: expect.any(String),
                target: {
                    kind: 'managed_service',
                    managedServiceId: 'managed-service-1',
                    machineId: 'machine-a',
                    sessionId: 'session-a',
                },
                action: 'stop_managed',
                force: false,
                confirmationNonce: expect.any(String),
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('builds a terminate-detected runtime action request for eligible detected rows', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            v: 1,
            requestId: 'request-terminate-detected',
            action: 'terminate_detected',
            status: 'succeeded',
            auditEvents: [],
        })) satisfies RuntimeActionExecute;
        const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1,
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            targets: [{
                id: 'inventory:inventory-entry-1',
                source: 'inventory_entry',
                sourceClass: {
                    kind: 'inventory_entry',
                    inventoryEntryId: 'inventory-entry-1',
                },
                machineId: 'machine-a',
                sessionId: 'session-a',
                title: 'Detected app',
                subtitle: 'localhost:5173',
                confidence: 'high',
                state: 'available',
                actions: ['open', 'terminate_detected'],
                browserTarget: {
                    kind: 'externalUrl',
                    targetId: 'inventory-loopback:inventory-entry-1',
                    url: 'http://127.0.0.1:5173/',
                    display: { title: 'Detected app', addressLabel: 'localhost:5173' },
                },
            }],
        } as LocalServiceLauncherSnapshot);
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId="server-a"
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'inventory-entry-1', state: 'listening' })],
                })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={launcherState}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:inventory:inventory-entry-1-terminate'),
            'session-rightpanel-services-row:inventory:inventory-entry-1-terminate',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.actions.terminateDetected',
            input: {
                requestId: expect.any(String),
                target: {
                    kind: 'inventory_entry',
                    inventoryEntryId: 'inventory-entry-1',
                    machineId: 'machine-a',
                    sessionId: 'session-a',
                },
                action: 'terminate_detected',
                force: false,
                confirmationNonce: expect.any(String),
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('loads live managed state and builds a restart-managed runtime action from daemon support', async () => {
        const managedSnapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: {
                generatedAt: 4_000,
                refreshState: 'idle' as const,
                rows: [buildManagedLocalServiceRow({
                    id: 'managed-service-1',
                    phase: 'running',
                    supportedActions: ['stop_managed', 'restart_managed'],
                })],
                diagnostics: [],
            },
        })) satisfies LocalServiceManagedSnapshotClient;
        const runtimeActionExecute = vi.fn(async () => ({
            v: 1,
            requestId: 'request-managed-service-1',
            action: 'restart_managed',
            status: 'succeeded',
            auditEvents: [],
        })) satisfies RuntimeActionExecute;
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId="server-a"
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildManagedLauncherState('managed-service-1')}
                managedSnapshotClient={managedSnapshotClient}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await vi.waitFor(() => {
            expect(screen.findByTestId('session-rightpanel-services-row:managed:managed-service-1-restart')).toBeTruthy();
        });
        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:managed:managed-service-1-restart'),
            'session-rightpanel-services-row:managed:managed-service-1-restart',
        );

        expect(managedSnapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
        }));
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.actions.restartManaged',
            input: {
                requestId: expect.any(String),
                target: {
                    kind: 'managed_service',
                    managedServiceId: 'managed-service-1',
                    machineId: 'machine-a',
                    sessionId: 'session-a',
                },
                action: 'restart_managed',
                force: false,
                confirmationNonce: expect.any(String),
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('builds a launcher start runtime action request for daemon-advertised Start targets', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'preview:session-feed',
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
            <SessionRightPanelServicesView
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
            screen.findByTestId('session-rightpanel-services-row:managed:session-feed-start'),
            'session-rightpanel-services-row:managed:session-feed-start',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'managed:session-feed',
                sessionId: 'session-a',
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('replaces live launcher state from successful Start response snapshots', async () => {
        const startedSnapshot = {
            ...liveStartSnapshot,
            updatedAt: 4_000,
            targets: [{
                ...liveStartSnapshot.targets[0],
                state: 'starting',
                actions: [],
            }],
        } satisfies LocalServiceLauncherSnapshot;
        const launcherSnapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: liveStartSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:session-feed',
            status: 'succeeded',
            snapshot: startedSnapshot,
        })) satisfies RuntimeActionExecute;
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId="server-a"
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherSnapshotClient={launcherSnapshotClient}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        expect(screen.findByTestId('session-rightpanel-services-row:managed:session-feed-start')).toBeTruthy();

        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:managed:session-feed-start'),
            'session-rightpanel-services-row:managed:session-feed-start',
        );

        await vi.waitFor(() => {
            expect(screen.findAllByTestId('session-rightpanel-services-row:managed:session-feed-start')).toHaveLength(0);
            expect(screen.findByTestId('session-rightpanel-services-row:managed:session-feed-status-starting')).toBeTruthy();
        });
    });

    it('creates public preview links through the session Services runtime action host', async () => {
        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            previewId: 'preview-session',
            exposureId: 'public-preview-1',
            status: 'created',
            exposure: {
                exposureId: 'public-preview-1',
                previewId: 'preview-session',
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
            <SessionRightPanelServicesView
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
            screen.findByTestId('session-rightpanel-services-row:preview:session-feed-public-preview-target:preview-session-create'),
            'session-rightpanel-services-row:preview:session-feed-public-preview-target:preview-session-create',
        );

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: 'preview-session',
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

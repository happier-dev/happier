import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureDecision, FeatureId, RuntimeActionExecute } from '@happier-dev/protocol';
import type { IModal } from '@/modal/types';
import { buildLocalServiceInventoryState } from '@/dev/testkit/fixtures/localServices';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

// Real Account lifetime beneath genuine network/device-credential boundaries;
// signed-out fixtures cannot dispatch through the mounted Services host.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
const { ProjectRightPanelServicesView } = await import('./ProjectRightPanelServicesView');

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
const modalShowMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: FeatureId, scope?: unknown) => useFeatureDecisionMock(featureId, scope),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
        spies: { confirm: modalConfirmMock, show: modalShowMock },
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
    let serverId: string;
    beforeEach(async () => {
        await home.reset();
        serverId = await home.addHome({ name: 'Project Home', serverUrl: 'https://project.example.test', accountId: 'project-account', currentAccount: true });
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
        modalShowMock.mockReset();
        modalShowMock.mockImplementation(() => 'modal-id');
    });
    afterEach(async () => { await home.reset(); });

    it('passes supplied local service launcher state into the Services pane', async () => {
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('mounts one body on the Services page and the rail: only the page leads with its purpose', async () => {
        const page = await renderScreen(
            <ProjectRightPanelServicesView
                presentation="page"
                testID="project-services-page"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(page.findByTestId('project-services-page-header')).toBeTruthy();
        expect(page.getTextContent()).toContain('Long-running services for this checkout');
        expect(page.findByTestId('project-services-page-row:inventory:project-feed')).toBeTruthy();
        await page.unmount();

        const rail = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(rail.findAllByTestId('project-rightpanel-services-header')).toHaveLength(0);
        expect(rail.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
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
                serverId={serverId}
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
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        // Let the real asynchronous credential binding publish before user ingress.
        await flushHookEffects();
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
                serverId,
                expectedAccountId: 'project-account',
                signal: expect.any(AbortSignal),
                surface: 'ui',
            },
        });
    });

    it('creates public preview links through the project Services runtime action host', async () => {
        modalShowMock.mockImplementationOnce((config) => {
            const props = (config as unknown as Readonly<{
                props: Readonly<{
                    modeChoices: readonly { mode: 'secret_link' | 'authenticated' }[];
                    ttlChoices: readonly { ttlMs: number }[];
                    onResolve: (decision: { mode: 'secret_link' | 'authenticated'; ttlMs: number } | null) => void;
                }>;
            }>).props;
            const mode = props.modeChoices[0];
            const ttl = props.ttlChoices[0];
            props.onResolve(mode && ttl ? { mode: mode.mode, ttlMs: ttl.ttlMs } : null);
            return 'modal-id';
        });
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
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildPublicPreviewLauncherState()}
                publicPreviewState={buildPublicPreviewState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await screen.pressByTestIdAsync('project-rightpanel-services-row:preview:project-feed-item');
        await flushHookEffects();
        await screen.pressByTestIdAsync('project-rightpanel-services-row:preview:project-feed-public-preview-target:preview-project-create');
        await flushHookEffects();

        expect(modalShowMock).toHaveBeenCalledOnce();
        expect(modalConfirmMock).not.toHaveBeenCalled();
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
                serverId,
                expectedAccountId: 'project-account',
                signal: expect.any(AbortSignal),
                surface: 'ui',
            },
        });
    });
});

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    applyLocalServiceInventoryRefreshStarted,
} from '@/sync/domains/local/services/inventory/store';
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
} from '@/sync/domains/local/services/launch';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';

function launcherStateWith(targets: LocalServiceLauncherSnapshot['targets'], sessionId?: string) {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        ...(sessionId ? { sessionId } : {}),
        updatedAt: 3_000,
        targets,
    });
}

const openableTarget = {
    id: 'inventory:openable-row',
    source: 'inventory_entry' as const,
    machineId: 'machine-a',
    sessionId: 'session-a',
    title: 'Openable preview',
    subtitle: 'localhost:5173',
    confidence: 'high' as const,
    state: 'available' as const,
    actions: ['open' as const],
    browserTarget: {
        kind: 'externalUrl' as const,
        targetId: 'inventory-loopback:openable-row',
        url: 'http://127.0.0.1:5173/',
        display: { title: 'Openable preview', addressLabel: 'localhost:5173' },
    },
};

describe('DetectedLocalServicesPane', () => {
    it('renders loading state before the first inventory snapshot', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [], generatedAt: 0, refreshState: 'refreshing' })}
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-loading')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-loading-card')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-loading-loading-spinner')).toBeTruthy();
    });

    it('renders empty state after an idle empty snapshot', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-empty')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-empty-card')).toBeTruthy();
    });

    it('renders terminal error state through the shared surface state card', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [],
                    refreshState: 'error',
                    diagnostics: [{ code: 'scanner_permission_denied', severity: 'error' }],
                })}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-error')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-error-card')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('scanner_permission_denied');
        expect(screen.findByTestId('local-services-pane-error-diagnostic-scanner_permission_denied')).toBeTruthy();
    });

    it('renders error diagnostics without clearing cached row state', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    refreshState: 'error',
                    rows: [buildLocalServiceInventoryRow({ id: 'stale-service', state: 'stale' })],
                    diagnostics: [{ code: 'scanner_permission_denied', severity: 'error' }],
                })}
                launcherState={launcherStateWith([{
                    id: 'inventory:stale-service',
                    source: 'inventory_entry',
                    machineId: 'machine-a',
                    title: 'Stale service',
                    confidence: 'low',
                    state: 'stale',
                    unavailableReason: 'stale_service',
                    actions: [],
                }])}
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-row:inventory:stale-service')).toBeTruthy();
        // FIX-E2: the diagnostics banner renders neutral product copy — the raw scan code is NOT
        // leaked into visible text; it survives only on the diagnostics-only testID/a11y hint.
        expect(screen.getTextContent()).not.toContain('scanner_permission_denied');
        expect(screen.getTextContent()).toContain('Local service scan needs attention');
        expect(screen.findByTestId('local-services-pane-error-code-scanner_permission_denied')).toBeTruthy();
    });

    it('renders a count badge from the live inventory + managed rows', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [
                        buildLocalServiceInventoryRow({ id: 'live-1', state: 'listening' }),
                        buildLocalServiceInventoryRow({ id: 'stale-1', state: 'stale' }),
                    ],
                })}
                managedState={buildManagedLocalServicesState({
                    rows: [buildManagedLocalServiceRow({ id: 'managed-1', phase: 'running' })],
                })}
                testID="local-services-pane"
            />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('3');
        expect(text).toContain('2');
    });

    it('renders launcher-unavailable state instead of synthesizing detected rows when daemon targets are empty', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'inventory-only', state: 'listening' })],
                })}
                launcherState={launcherStateWith([])}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-launcher-unavailable')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-launcher-unavailable-card')).toBeTruthy();
        expect(screen.findAllByTestId('local-services-pane-row:inventory:inventory-only')).toHaveLength(0);
        expect(screen.findAllByTestId('local-services-pane-row:inventory:inventory-only-open')).toHaveLength(0);
    });

    it('ranks this-session above workspace and suggestions last, in a single banded list (D1, D6)', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [
                        buildLocalServiceInventoryRow({ id: 'my-session', state: 'listening' }),
                        buildLocalServiceInventoryRow({ id: 'other-session', state: 'listening' }),
                    ],
                })}
                launcherState={launcherStateWith([
                    {
                        id: 'inventory:my-session',
                        source: 'inventory_entry',
                        machineId: 'machine-a',
                        sessionId: 'session-a',
                        title: 'My session',
                        confidence: 'high',
                        state: 'available',
                        actions: ['open'],
                        browserTarget: { kind: 'externalUrl', targetId: 'l1', url: 'http://127.0.0.1:5173/', display: { title: 'My session' } },
                    },
                    {
                        id: 'inventory:other-session',
                        source: 'inventory_entry',
                        machineId: 'machine-a',
                        sessionId: 'session-b',
                        title: 'Other session',
                        confidence: 'high',
                        state: 'available',
                        actions: ['open'],
                        browserTarget: { kind: 'externalUrl', targetId: 'l2', url: 'http://127.0.0.1:5174/', display: { title: 'Other session' } },
                    },
                    {
                        id: 'package:web:dev',
                        source: 'package_script',
                        machineId: 'machine-a',
                        title: 'web:dev',
                        confidence: 'medium',
                        state: 'unavailable',
                        unavailableReason: 'launch_unavailable',
                        actions: [],
                    },
                ], 'session-a')}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-band-thisSession')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-band-workspace')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-band-suggestion')).toBeTruthy();
        // No raw reason token rendered (D6, master §3.4).
        expect(screen.getTextContent()).not.toContain('launch_unavailable');

        const order = screen
            .findAll((node) => typeof node.props?.testID === 'string'
                && /^local-services-pane-row:(inventory:my-session|inventory:other-session|package:web:dev)$/.test(node.props.testID))
            .map((node) => node.props.testID as string);
        expect(order.indexOf('local-services-pane-row:inventory:my-session'))
            .toBeLessThan(order.indexOf('local-services-pane-row:inventory:other-session'));
        expect(order.indexOf('local-services-pane-row:inventory:other-session'))
            .toBeLessThan(order.indexOf('local-services-pane-row:package:web:dev'));
    });

    it('threads onOpenServiceInBrowser to an openable row and invokes it with the open target', async () => {
        const onOpenServiceInBrowser = vi.fn();
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={launcherStateWith([openableTarget], 'session-a')}
                sessionId="session-a"
                onOpenServiceInBrowser={onOpenServiceInBrowser}
                testID="local-services-pane"
            />,
        );
        await pressTestInstanceAsync(
            screen.findByTestId('local-services-pane-row:inventory:openable-row-open'),
            'local-services-pane-row:inventory:openable-row-open',
        );
        expect(onOpenServiceInBrowser).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ id: 'inventory:openable-row' }),
        );
    });

    it('preserves the public-preview control on an exposure-bearing row (§5.7)', async () => {
        const previewTarget = {
            id: 'preview:preview_1',
            source: 'registered_preview' as const,
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Dashboard preview',
            confidence: 'high' as const,
            state: 'available' as const,
            actions: [] as never[],
            browserTarget: {
                kind: 'localServicePreview' as const,
                targetId: 'preview_1',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        };
        const exposure = {
            exposureId: 'public_preview_1',
            previewId: 'preview_1',
            sessionId: 'session-a',
            machineId: 'machine-a',
            mode: 'secret_link' as const,
            state: 'active' as const,
            publicUrl: 'https://preview.example.test/s/public_preview_1',
            issuedAt: 1_000,
            expiresAt: 601_000,
            auditEventIds: ['audit_1'],
            rateLimitProfileId: 'default',
        };
        const publicPreviewState = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
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
            exposures: [exposure],
            diagnostics: [],
        });

        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={launcherStateWith([previewTarget], 'session-a')}
                publicPreviewState={publicPreviewState}
                publicPreviewActions={{ create: vi.fn(), copyUrl: vi.fn(), revoke: vi.fn() }}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-row:preview:preview_1-public-preview-exposure:public_preview_1-revoke')).toBeTruthy();
    });

    it('renders disabled public-preview state on a plain loopback open row (§5.7)', async () => {
        const publicPreviewState = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
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
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={launcherStateWith([openableTarget], 'session-a')}
                publicPreviewState={publicPreviewState}
                publicPreviewActions={{ create: vi.fn(), copyUrl: vi.fn(), revoke: vi.fn() }}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-row:inventory:openable-row-public-preview-target:inventory:openable-row-disabled')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Open a local preview before creating a public link.');
        expect(screen.findAll((node) => String(node.props?.testID ?? '').endsWith('-create'))).toHaveLength(0);
    });

    it('keeps the prior hydrated rows mounted while the launcher is refreshing (§5.8 keep-last-good)', async () => {
        const refreshingLauncher = {
            ...launcherStateWith([openableTarget], 'session-a'),
            refreshStatus: 'refreshing' as const,
        };
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={refreshingLauncher}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        // FIX-C: no visible refresh banner — a banner that toggled on every background poll
        // caused layout-shift flicker. The hydrated rows stay mounted (keep-last-good) while the
        // launcher revalidates; the refresh is silent.
        expect(screen.findAllByTestId('local-services-pane-refreshing')).toHaveLength(0);
        expect(screen.findByTestId('local-services-pane-row:inventory:openable-row')).toBeTruthy();
    });
});

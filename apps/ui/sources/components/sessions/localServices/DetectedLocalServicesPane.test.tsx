import * as React from 'react';
import { describe, expect, it } from 'vitest';

import {
    applyLocalServiceInventoryRefreshStarted,
} from '@/sync/domains/local/services/inventory/store';
import {
    applyManagedLocalServicesRefreshStarted,
} from '@/sync/domains/local/services/managed/store';
import {
    buildLocalServiceInventoryRow,
    buildLocalServiceInventoryState,
    buildManagedLocalServiceRow,
    buildManagedLocalServicesState,
    renderScreen,
} from '@/dev/testkit';

import { DetectedLocalServiceRow } from './DetectedLocalServiceRow';
import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import { ManagedLocalServiceRow } from './ManagedLocalServiceRow';

describe('DetectedLocalServicesPane', () => {
    it('renders loading state before the first inventory snapshot', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [], generatedAt: 0, refreshState: 'refreshing' })}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-loading')).toBeTruthy();
    });

    it('keeps cached inventory rows visible while refresh is in flight', async () => {
        const hydrated = buildLocalServiceInventoryState({
            rows: [buildLocalServiceInventoryRow({ id: 'vite-5173' })],
        });
        const refreshing = applyLocalServiceInventoryRefreshStarted(hydrated, 'machine-a', 2_000);

        const screen = await renderScreen(
            <DetectedLocalServicesPane inventoryState={refreshing} testID="local-services-pane" />,
        );

        expect(screen.findByTestId('local-services-pane-refreshing')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-detected:vite-5173')).toBeTruthy();
    });

    it('keeps managed rows visible while managed services refresh', async () => {
        const hydrated = buildManagedLocalServicesState({
            rows: [buildManagedLocalServiceRow({ id: 'managed-refreshing' })],
        });
        const refreshing = applyManagedLocalServicesRefreshStarted(hydrated, 2_000);

        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={refreshing}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-refreshing')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-managed:managed-refreshing')).toBeTruthy();
    });

    it('renders empty state after an idle empty snapshot', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-empty')).toBeTruthy();
    });

    it('renders error diagnostics without clearing cached row state', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    refreshState: 'error',
                    rows: [buildLocalServiceInventoryRow({ id: 'stale-service', state: 'stale' })],
                    diagnostics: [{ code: 'scanner_permission_denied', severity: 'error' }],
                })}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-error')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-detected:stale-service')).toBeTruthy();
        expect(screen.getTextContent()).toContain('scanner_permission_denied');
    });

    it('renders managed refresh diagnostics when inventory is empty', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({
                    refreshState: 'error',
                    rows: [],
                    diagnostics: [{ code: 'managed_refresh_failed', severity: 'error' }],
                })}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-error')).toBeTruthy();
        expect(screen.getTextContent()).toContain('managed_refresh_failed');
    });

    it('marks gone inventory rows distinctly', async () => {
        const screen = await renderScreen(
            <DetectedLocalServiceRow
                row={buildLocalServiceInventoryRow({ id: 'gone-service', state: 'gone' })}
                testID="detected-row"
            />,
        );

        expect(screen.findByTestId('detected-row-status-gone')).toBeTruthy();
    });

    it('uses service title, labels, classifier name, and address facts for identity', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [
                        buildLocalServiceInventoryRow({
                            id: 'dashboard',
                            presentation: { pageTitle: 'Dashboard', folderLabel: 'web' },
                            labels: [{ id: 'label-1', text: 'Pinned Preview', source: 'user', updatedAt: 1_000 }],
                        }),
                        buildLocalServiceInventoryRow({
                            id: 'classifier',
                            port: 3000,
                            classification: { displayName: 'Next.js dev server' },
                            presentation: { addressLabel: 'localhost:3000' },
                        }),
                    ],
                })}
                testID="local-services-pane"
            />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('Dashboard');
        expect(text).toContain('Pinned Preview');
        expect(text).toContain('web');
        expect(text).toContain('Next.js dev server');
        expect(text).toContain('localhost:3000');
    });

    it('does not render process command provenance unless it was redacted by the daemon', async () => {
        const unsafe = await renderScreen(
            <DetectedLocalServiceRow
                row={buildLocalServiceInventoryRow({
                    provenance: {
                        process: {
                            pid: 1234,
                            command: 'vite --token sk-secret',
                            redacted: false,
                        },
                    },
                })}
                testID="unsafe-row"
            />,
        );
        expect(unsafe.getTextContent()).not.toContain('sk-secret');

        const safe = await renderScreen(
            <DetectedLocalServiceRow
                row={buildLocalServiceInventoryRow({
                    provenance: {
                        process: {
                            pid: 1234,
                            command: 'vite --token [REDACTED]',
                            redacted: true,
                        },
                    },
                })}
                testID="safe-row"
            />,
        );
        expect(safe.getTextContent()).toContain('[REDACTED]');
    });

    it('renders managed service state and diagnostics beside inventory', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'inventory-1' })],
                })}
                managedState={buildManagedLocalServicesState({
                    rows: [
                        buildManagedLocalServiceRow({
                            id: 'managed-1',
                            phase: 'unhealthy',
                            diagnostics: [{ code: 'health_timeout', severity: 'warning' }],
                        }),
                    ],
                })}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-managed:managed-1')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-managed:managed-1-status-unhealthy')).toBeTruthy();
        expect(screen.getTextContent()).toContain('health_timeout');
    });
});

describe('ManagedLocalServiceRow', () => {
    it('renders stopped and failed managed service diagnostics distinctly', async () => {
        const screen = await renderScreen(
            <ManagedLocalServiceRow
                row={buildManagedLocalServiceRow({
                    id: 'failed-service',
                    phase: 'failed',
                    ownerLabel: 'Worker UI',
                    diagnostics: [{ code: 'port_collision', severity: 'error' }],
                })}
                testID="managed-row"
            />,
        );

        expect(screen.findByTestId('managed-row-status-failed')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Worker UI');
        expect(screen.getTextContent()).toContain('port_collision');
    });
});

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalServicePublicPreviewSnapshotV1 } from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn<IModal['confirm']>(async () => true),
}));

const clipboardSpies = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async (_value: string) => true),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalSpies.confirm } }).module;
});

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: clipboardSpies.setClipboardStringSafe,
}));

import { ServiceRowView } from './ServiceRowView';

function launchTarget(overrides: Partial<LocalServiceLaunchTarget> = {}): LocalServiceLaunchTarget {
    return {
        id: 'package:web:dev',
        source: 'package_script',
        machineId: 'machine-a',
        title: 'web:dev',
        confidence: 'medium',
        state: 'unavailable',
        unavailableReason: 'launch_unavailable',
        actions: [],
        ...overrides,
    } as LocalServiceLaunchTarget;
}

function serviceRow(overrides: Partial<ServiceRow> = {}): ServiceRow {
    const target = overrides.target ?? launchTarget();
    return {
        id: 'package:web:dev',
        scope: 'suggestion',
        title: 'web:dev',
        portLabel: null,
        scheme: null,
        host: null,
        workspaceLabel: '/repo/web',
        processLabel: null,
        sourceLabel: 'localServices.source.packageScript',
        status: 'unavailable',
        reasonCode: 'launch_unavailable',
        primaryAction: null,
        managed: null,
        terminateIdentityConfidence: null,
        target,
        ...overrides,
    };
}

describe('ServiceRowView', () => {
    beforeEach(() => {
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
        clipboardSpies.setClipboardStringSafe.mockClear();
        clipboardSpies.setClipboardStringSafe.mockResolvedValue(true);
    });

    it('renders a human caption for an inert reason code, never the raw code', async () => {
        const screen = await renderScreen(
            <ServiceRowView row={serviceRow()} testID="row" />,
        );
        expect(screen.getTextContent()).not.toContain('launch_unavailable');
        expect(screen.findByTestId('row-reason')).toBeTruthy();
    });

    it('renders exactly one open primary action for an openable row and invokes it with the open target', async () => {
        const openTarget = launchTarget({
            id: 'inventory:entry-a',
            source: 'inventory_entry',
            state: 'available',
            actions: ['open'],
            unavailableReason: undefined,
            browserTarget: {
                kind: 'externalUrl',
                targetId: 'inventory-loopback:entry-a',
                url: 'http://127.0.0.1:5173/',
                display: { title: 'Vite', addressLabel: 'localhost:5173' },
            },
        });
        const onOpen = vi.fn();
        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    id: 'inventory:entry-a',
                    scope: 'thisSession',
                    title: 'Vite',
                    portLabel: ':5173',
                    host: '127.0.0.1',
                    status: 'running',
                    reasonCode: null,
                    sourceLabel: 'localServices.source.detected',
                    primaryAction: { kind: 'open', openTarget },
                    target: openTarget,
                })}
                onOpenServiceInBrowser={onOpen}
                testID="row"
            />,
        );
        expect(screen.getTextContent()).toContain(':5173');
        await pressTestInstanceAsync(screen.findByTestId('row-open'), 'row-open');
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(openTarget);
        expect(screen.findAllByTestId('row-start')).toHaveLength(0);
    });

    it('copies the concrete service address from the row without requiring the public-preview card', async () => {
        const target = launchTarget({
            id: 'inventory:entry-a',
            source: 'inventory_entry',
            state: 'available',
            actions: ['open'],
            unavailableReason: undefined,
        });

        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    id: 'inventory:entry-a',
                    scope: 'thisSession',
                    title: 'Vite',
                    portLabel: ':5173',
                    scheme: 'http',
                    host: '127.0.0.1',
                    status: 'running',
                    reasonCode: null,
                    sourceLabel: 'localServices.source.detected',
                    target,
                })}
                testID="row"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('row-copy-address'), 'row-copy-address');

        expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:5173');
        expect(screen.findByTestId('row-copy-address-feedback')).toBeTruthy();
    });

    it('renders a visible PID-only terminate confidence note for detected terminate rows', async () => {
        const target = launchTarget({
            id: 'inventory:entry-a',
            source: 'inventory_entry',
            state: 'available',
            actions: ['terminate_detected'],
            unavailableReason: undefined,
        });

        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    id: 'inventory:entry-a',
                    scope: 'thisSession',
                    title: 'Vite',
                    status: 'running',
                    reasonCode: null,
                    sourceLabel: 'localServices.source.detected',
                    target,
                    terminateIdentityConfidence: 'pid_only',
                })}
                onTerminateDetectedService={vi.fn()}
                testID="row"
            />,
        );

        expect(screen.findByTestId('row-terminate-confidence')).toBeTruthy();
    });

    it('confirms before terminating a detected service and cancels cleanly when declined', async () => {
        const target = launchTarget({
            id: 'inventory:entry-a',
            source: 'inventory_entry',
            state: 'available',
            actions: ['terminate_detected'],
            unavailableReason: undefined,
        });
        const onTerminate = vi.fn();
        modalSpies.confirm.mockResolvedValueOnce(false);

        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    id: 'inventory:entry-a',
                    scope: 'thisSession',
                    title: 'Vite',
                    status: 'running',
                    reasonCode: null,
                    sourceLabel: 'localServices.source.detected',
                    target,
                    terminateIdentityConfidence: 'pid_only',
                })}
                onTerminateDetectedService={onTerminate}
                testID="row"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('row-terminate'), 'row-terminate');

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(onTerminate).not.toHaveBeenCalled();
    });

    it('confirms before stopping a managed service row', async () => {
        const managed = {
            id: 'managed-1',
            phase: 'running',
            launchMode: 'detectAfterLaunch',
            supportedActions: ['stop_managed'],
            diagnostics: [],
            updatedAt: 1_000,
            ownerLabel: 'Dev server',
            port: 5173,
        } as const;
        const onStop = vi.fn();

        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    id: 'managed-1',
                    scope: 'thisSession',
                    title: 'Dev server',
                    portLabel: ':5173',
                    status: 'running',
                    reasonCode: null,
                    sourceLabel: 'localServices.source.managed',
                    target: launchTarget({
                        id: 'managed-1',
                        source: 'managed_service',
                        state: 'available',
                        actions: [],
                    }),
                    managed,
                })}
                onStopManagedService={onStop}
                testID="row"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('row-stop'), 'row-stop');

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(onStop).toHaveBeenCalledExactlyOnceWith(managed);
    });

    it('keeps public preview disabled state visible for detected external-url rows without preview ids', async () => {
        const target = launchTarget({
            id: 'inventory:entry-a',
            source: 'inventory_entry',
            state: 'available',
            actions: ['open'],
            unavailableReason: undefined,
            browserTarget: {
                kind: 'externalUrl',
                targetId: 'inventory-loopback:entry-a',
                url: 'http://127.0.0.1:5173/',
                display: { title: 'Vite', addressLabel: 'localhost:5173' },
            },
        });
        const publicPreviewState = applyLocalServicePublicPreviewSnapshot(
            createLocalServicePublicPreviewState(),
            {
                v: 1,
                machineId: 'machine-a',
                sessionId: 'session-a',
                generatedAt: 1_000,
                refreshState: 'idle',
                policy: {
                    enabled: true,
                    allowedModes: ['secret_link'],
                    maxConcurrentExposures: 1,
                    dnsTlsRequired: true,
                    auditRequired: true,
                    rateLimitProfileIds: ['default'],
                },
                exposures: [],
                diagnostics: [],
            } satisfies LocalServicePublicPreviewSnapshotV1,
        );

        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    id: 'inventory:entry-a',
                    scope: 'thisSession',
                    title: 'Vite',
                    portLabel: ':5173',
                    host: '127.0.0.1',
                    status: 'running',
                    reasonCode: null,
                    sourceLabel: 'localServices.source.detected',
                    primaryAction: { kind: 'open', openTarget: target },
                    target,
                })}
                onOpenServiceInBrowser={vi.fn()}
                publicPreviewState={publicPreviewState}
                publicPreviewActions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
                testID="row"
            />,
        );

        const text = screen.getTextContent();
        expect(screen.findByTestId('row-public-preview')).toBeTruthy();
        expect(text).toContain('Open a local preview before creating a public link.');
        expect(text).toContain('Secret link');
        expect(text).not.toContain('secret_link');
        expect(text).not.toContain('authenticated');
        expect(screen.findAll((node) => String(node.props?.testID ?? '').endsWith('-create'))).toHaveLength(0);
    });
});

import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Text } from '@/components/ui/text/Text';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import { buildLocalServiceRows, selectRunningOpenTargetOnPort, type ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';
import {
    createLocalServicePreviewState,
    type LocalServicePreviewRow,
    type LocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn<IModal['confirm']>(async () => true),
    alert: vi.fn<IModal['alert']>(),
}));

const clipboardSpies = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async (_value: string) => true),
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalSpies.confirm, alert: modalSpies.alert } }).module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: clipboardSpies.setClipboardStringSafe,
}));

import { ServiceRowView } from './ServiceRowView';

function PlacementProbe(): React.ReactElement {
    return <Text testID="placement-probe">Runs on</Text>;
}

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
        terminateIdentityConfidence: null,
        target,
        internal: false,
        ...overrides,
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, item) => Object.assign(acc, flattenStyle(item)), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function collectMetaText(node: { children: ReadonlyArray<unknown> }): string {
    return node.children.map((child) => typeof child === 'string' ? child : collectMetaText(child as { children: ReadonlyArray<unknown> })).join(' ');
}

describe('ServiceRowView', () => {
    it('shows pending binding discovery as loading without an unavailable reason or Start', async () => {
        const target = LocalServiceLaunchTargetV1Schema.parse(launchTarget({ source: 'managed_service',
            workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/accepted' },
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'web' } },
            unavailableReason: 'project_service_binding_pending' }));
        const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        const screen = await renderScreen(<ServiceRowView row={row!} onStartLauncherTarget={vi.fn()} testID="row" />);
        // Hydration is not a state of the service: no status word beside the name, just the row's own spinner,
        // with the same facts line the idle row draws so the row keeps its height.
        expect(screen.findByTestId('row-status-loading')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Loading');
        expect(screen.findByType(Item).props.loading).toBe(true);
        expect(screen.findByTestId('row-source')).toBeTruthy();
        expect(screen.findByTestId('row-start')).toBeNull();
        expect(screen.findByTestId('row-reason')).toBeNull();
        expect(screen.findByTestId('row-dot-halo')).toBeNull();
    });

    it('dispatches a qualified declaration Start from the actual row model without fabricating an executable feed action', async () => {
        const target = launchTarget({ source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'project-service:selected' },
            workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/accepted' },
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'docs' } },
            commandPreview: 'current declaration command' });
        const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        // Start dispatch is the outer consumer port; the current row model and
        // actual rendered control remain real.
        const start = vi.fn(async () => undefined);
        const screen = await renderScreen(<ServiceRowView row={row!} onStartLauncherTarget={start} testID="row" />);
        await pressTestInstanceAsync(screen.findByTestId('row-start'), 'row-start');
        expect(start).toHaveBeenCalledExactlyOnceWith(target);
        expect(target.actions).toEqual([]);
    });

    function declaredStartRow(title = 'web') {
        const target = launchTarget({ source: 'managed_service', title, sourceClass: { kind: 'managed_service', managedServiceId: 'project-service:selected' },
            workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/accepted' },
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: title } }, commandPreview: 'vite' });
        const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
        return { row: row!, target };
    }
    const portInUse = { status: 'denied', reasonCode: 'plugin_managed_service_establishment_failed',
        establishmentFailure: { cause: 'port_in_use', port: 5173, exitCode: 1, sameProject: true, lastStderrLine: 'Error: listen EADDRINUSE :::5173' } };

    it('keeps an unconfirmed Start inspect-only until the native feed observes the actual binding', async () => {
        const { row, target } = declaredStartRow();
        const start = vi.fn(async () => ({ ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' }));
        const screen = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={start} testID="row" />);
        await pressTestInstanceAsync(screen.findByTestId('row-start'), 'row-start');
        expect(screen.getTextContent()).toContain('outcome is unknown');
        expect(screen.getTextContent()).not.toContain('Could not start');
        expect(screen.findByTestId('row-failure.action')).toBeNull();
        expect(screen.findByTestId('row-start')).toBeNull();
        await screen.update(<ServiceRowView row={{ ...row, target: { ...target } }} onStartLauncherTarget={start} testID="row" />);
        expect(screen.findByTestId('row-start')).toBeNull();
        const [running] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{ ...target,
            sourceClass: { kind: 'managed_service', managedServiceId: 'actual-instance' }, state: 'available',
            serviceState: 'running', readiness: 'ready', actions: ['manage'], unavailableReason: undefined,
        }], sessionId: null, scope: 'workspace' });
        await screen.update(<ServiceRowView row={running!} onStartLauncherTarget={start} testID="row" />);
        expect(screen.findByTestId('row-failure')).toBeNull();
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('settles a lost Start acknowledgement when the native binding was observed before the result', async () => {
        const { row, target } = declaredStartRow();
        let settle!: (value: unknown) => void;
        const start = vi.fn(() => new Promise(resolve => { settle = resolve; }));
        const screen = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={start} testID="row" />);
        let pending!: Promise<unknown>;
        await act(async () => { pending = pressTestInstanceAsync(screen.findByTestId('row-start'), 'row-start'); });
        const [running] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{ ...target,
            sourceClass: { kind: 'managed_service', managedServiceId: 'actual-instance' }, state: 'available',
            serviceState: 'running', readiness: 'ready', actions: ['manage'], unavailableReason: undefined,
        }], sessionId: null, scope: 'workspace' });
        await screen.update(<ServiceRowView row={running!} onStartLauncherTarget={start} testID="row" />);
        await act(async () => { settle({ ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' }); await pending; });
        expect(screen.findByTestId('row-failure')).toBeNull();
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('reads a refused Start in place on its own row, with the codes behind Details and no dialog', async () => {
        const { row } = declaredStartRow();
        const screen = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={vi.fn(async () => portInUse)} testID="row" />);
        await pressTestInstanceAsync(screen.findByTestId('row-start'), 'row-start');
        expect(modalSpies.alert).not.toHaveBeenCalled();
        const text = screen.getTextContent();
        expect(text).toContain('Could not start web');
        expect(text).toContain('Port 5173 is already in use by this project');
        expect(text).not.toContain('plugin_managed_service_establishment_failed');
        expect(text).not.toContain('EADDRINUSE');
        await pressTestInstanceAsync(screen.findByTestId('row-failure.details'), 'row-failure.details');
        const details = screen.getTextContent();
        expect(details).toContain('EADDRINUSE');
        expect(details).toContain('plugin_managed_service_establishment_failed');
        expect(details).toContain('1');
    });

    it('keeps the published lifecycle while the Start front door is pending', async () => {
        const { row } = declaredStartRow();
        let settle!: (result: unknown) => void;
        const start = vi.fn(() => new Promise<unknown>((resolve) => { settle = resolve; }));
        const screen = await renderScreen(<ServiceRowView row={row} machineName="devbox" onStartLauncherTarget={start} testID="row" />);
        expect(screen.getTextContent()).not.toContain('Starting');
        const idleMeta = collectMetaText(screen.findByTestId('row-meta')!).replace(/\s+/g, ' ');
        await act(async () => { void pressTestInstanceAsync(screen.findByTestId('row-start'), 'row-start'); });
        expect(screen.getTextContent()).not.toContain('Starting');
        expect(collectMetaText(screen.findByTestId('row-meta')!).replace(/\s+/g, ' ')).toBe(idleMeta);
        expect(screen.findByTestId('row-source')).toBeTruthy();
        await screen.update(<ServiceRowView row={{ ...row, status: 'unavailable', primaryAction: null,
            reasonCode: 'project_service_binding_unavailable' }} machineName="devbox" onStartLauncherTarget={start} testID="row" />);
        expect(screen.findByTestId('row-status-starting')).toBeNull();
        expect(screen.findByTestId('row-status-unavailable')).toBeTruthy();
        await act(async () => { settle({ status: 'succeeded' }); await Promise.resolve(); });
        expect(screen.getTextContent()).not.toContain('Starting');
    });

    it('offers the same project\'s running instance instead of Retry, and Retry otherwise', async () => {
        const { row, target } = declaredStartRow();
        const running = LocalServiceLaunchTargetV1Schema.parse(launchTarget({ id: 'inventory:5173', source: 'inventory_entry', title: 'Lumen Studio :5173',
            workspace: target.workspace, state: 'available', unavailableReason: undefined, subtitle: 'localhost:5173', actions: ['open'],
            browserTarget: { kind: 'externalUrl', targetId: 'running:5173', url: 'http://localhost:5173/' } }));
        const unrelated = LocalServiceLaunchTargetV1Schema.parse({ ...running, id: 'source-listener', machineId: 'source-machine',
            workspace: { ...target.workspace!, machineId: 'source-machine', workspaceId: 'source-checkout', rootPath: '/source' } });
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [unrelated, running, target], sessionId: null, scope: 'workspace' });
        const onOpen = vi.fn(async (_target: LocalServiceLaunchTarget) => ({ status: 'succeeded' as const }));
        const start = vi.fn(async (_target: LocalServiceLaunchTarget) => portInUse);
        const screen = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={start} onOpenServiceInBrowser={onOpen}
            findRunningOpenTarget={(port, failedTarget) => selectRunningOpenTargetOnPort(rows, port, failedTarget)} testID="row" />);
        await pressTestInstanceAsync(screen.findByTestId('row-start'), 'row-start');
        expect(screen.getTextContent()).toContain('Open running web');
        expect(screen.getTextContent()).not.toContain('Retry');
        await pressTestInstanceAsync(screen.findByTestId('row-failure.action'), 'row-failure.action');
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(running);
        expect(start).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId('row-failure')).toHaveLength(0);

        // No running instance to point at: the next action is Retry, and it re-runs the same Start.
        const unrelatedRows = rows.filter((candidate) => candidate.id !== running.id);
        const lone = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={start}
            findRunningOpenTarget={(port, failedTarget) => selectRunningOpenTargetOnPort(unrelatedRows, port, failedTarget)} testID="row" />);
        await pressTestInstanceAsync(lone.findByTestId('row-start'), 'row-start');
        expect(lone.getTextContent()).toContain('Retry');
        expect(lone.getTextContent()).not.toContain('Open running');
        await pressTestInstanceAsync(lone.findByTestId('row-failure.action'), 'row-failure.action');
        expect(start).toHaveBeenCalledTimes(3);
        expect(start).toHaveBeenLastCalledWith(target);
    });

    it('offers no address for a stopped Service: nothing answers there until it starts again', async () => {
        const target = launchTarget({ source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'stopped-instance' },
            state: 'available', serviceState: 'stopped', actions: ['manage'], endpointUrl: 'http://localhost:5173/' });
        const screen = await renderScreen(<ServiceRowView row={serviceRow({ target, scope: 'workspace', status: 'stopped',
            reasonCode: null, portLabel: ':5173', host: 'localhost', scheme: 'http' })} expanded onExpandedChange={vi.fn()} testID="row" />);
        expect(screen.findAllByTestId('row-copy-address')).toHaveLength(0);
    });

    it('does not copy a managed address through the renderer when its canonical Action port is absent', async () => {
        const target = launchTarget({ source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'actual-instance' },
            state: 'available', serviceState: 'running', actions: ['manage'], endpointUrl: 'http://localhost:5173/' });
        const screen = await renderScreen(<ServiceRowView row={serviceRow({ target, scope: 'workspace', status: 'running',
            reasonCode: null, portLabel: ':5173', host: 'localhost', scheme: 'http' })} expanded onExpandedChange={vi.fn()} testID="row" />);
        await pressTestInstanceAsync(screen.findByTestId('row-copy-address'), 'row-copy-address');
        expect(clipboardSpies.setClipboardStringSafe).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        modalSpies.alert.mockReset();
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
        clipboardSpies.setClipboardStringSafe.mockClear();
        clipboardSpies.setClipboardStringSafe.mockResolvedValue(true);
        installBrowserClipboardBoundary(async text => { await clipboardSpies.setClipboardStringSafe(text); });
    });

    /**
     * SB-F — the row's status dot and its status pill are two renderings of ONE decision.
     *
     * `ServiceRow.status` is produced by the single owner (`buildLocalServiceRows` →
     * `resolveStatus`). The dot used to re-derive its own liveness from the raw
     * `row.target.state` instead, so one element carried two owners: its accessibility label
     * already came from `row.status` while its tone came from the raw launch-target state.
     *
     * These two cases put the two fields in conflict on purpose. That is not decoration: the two
     * derivations agree on every consistent row (`available→running→live`, `starting→live`,
     * `stale→idle`, `unavailable→gone`), so a test built from a row the row-model actually
     * produces would pass against the broken implementation too and prove nothing. A divergent
     * row is the only input that separates them — and the fix is what makes such a row
     * unrepresentable at the call site.
     */
    function dotHaloBackground(screen: Awaited<ReturnType<typeof renderScreen>>): unknown {
        return flattenStyle(screen.findByTestId('row-dot-halo')?.props.style).backgroundColor;
    }

    it('renders a live dot for a running row even when the raw launch-target state says otherwise', async () => {
        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    status: 'running',
                    target: launchTarget({ state: 'unavailable', unavailableReason: 'launch_unavailable' }),
                })}
                testID="row"
            />,
        );

        // Live is the only liveness that paints the halo; a themed token, never `transparent`.
        const halo = dotHaloBackground(screen);
        expect(halo).toEqual(expect.any(String));
        expect(halo).not.toBe('transparent');
    });

    it('renders a non-live dot for an unavailable row even when the raw launch-target state says otherwise', async () => {
        const screen = await renderScreen(
            <ServiceRowView
                row={serviceRow({
                    status: 'unavailable',
                    target: launchTarget({ state: 'available', unavailableReason: undefined, actions: ['open'] }),
                })}
                testID="row"
            />,
        );

        // The soft ring belongs to a live service only.
        expect(screen.findByTestId('row-dot-halo')).toBeNull();
    });

    /**
     * Healthy is quiet (DESIGN: "no indefinite decorative animation on routine surfaces"; H-UX F-11).
     * A running service keeps its dot still; only `starting` — a state that is actually in progress —
     * moves. On the native path a pulsing dot is the one whose opacity is driven by an animation.
     */
    function dotStyle(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
        return flattenStyle(screen.findByTestId('row-dot')?.props.style);
    }

    it('keeps a running service still: its dot does not pulse', async () => {
        const screen = await renderScreen(
            <ServiceRowView row={serviceRow({ status: 'running', reasonCode: null })} testID="row" />,
        );

        expect(screen.findByTestId('row-dot')).not.toBeNull();
        expect(dotStyle(screen).opacity).toBeUndefined();
    });

    it('pulses the dot only while a service is starting', async () => {
        const { Platform } = await import('react-native');
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        const previousPlatform = { ...Platform };
        // This assertion observes native Animated opacity, not the web CSS pulse.
        Object.assign(Platform, (await createReactNativeNativeMock({ platformOS: 'ios' })).Platform);
        try {
            const screen = await renderScreen(
                <ServiceRowView row={serviceRow({ status: 'starting', reasonCode: null })} testID="row" />,
            );
            expect(dotStyle(screen).opacity).toBeDefined();
            await screen.unmount();
        } finally { Object.assign(Platform, previousPlatform); }
    });

    it('announces the status once: the dot is hidden because the row says it in words', async () => {
        const screen = await renderScreen(
            <ServiceRowView row={serviceRow({ status: 'running', reasonCode: null })} testID="row" />,
        );

        const dot = screen.findByTestId('row-dot');
        expect(dot?.props.accessibilityLabel).toBeUndefined();
        expect(dot?.props.accessibilityElementsHidden).toBe(true);
        expect(screen.findByTestId('row-status-running')).not.toBeNull();
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
                expanded
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );
        expect(screen.getTextContent()).toContain(':5173');
        await pressTestInstanceAsync(screen.findByTestId('row-open'), 'row-open');
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(openTarget);
        expect(screen.findAllByTestId('row-start')).toHaveLength(0);
    });

    it('copies the concrete service address from the expanded row without requiring a public link', async () => {
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
                expanded
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('row-copy-address'), 'row-copy-address');

        expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:5173');
        expect(screen.findByTestId('row-copy-address-feedback')).toBeTruthy();
    });

    /**
     * Lab RUNSONp: the phone's pushed detail is one grouped list. Address is a row that opens the
     * service (the secondary line says where), copying is a menu action, and nothing in the group is a
     * hand-built button; the Service's Stop is the destructive row under the group, not a menu entry.
     */
    it('draws the phone detail as a grouped list: Address opens the service and Copy address moves into the menu', async () => {
        const row = { ...openableRow(), scheme: 'http' as const };
        const onOpen = vi.fn(async () => undefined);
        const screen = await renderScreen(
            <ServiceRowView row={row} presentation="detail" onOpenServiceInBrowser={onOpen}
                placement={<PlacementProbe />} testID="row" />,
        );
        expect(screen.findAllByTestId('row-copy-address')).toHaveLength(0);
        expect(screen.findAllByTestId('row-open')).toHaveLength(0);
        expect(screen.findByTestId('placement-probe')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Address');
        // The Address row names the address the facts line shows, never a bare port.
        expect(screen.findAllByType(Item).find((item) => item.props.testID === 'row-address')?.props.detail).toBe('localhost:5173');
        await pressTestInstanceAsync(screen.findByTestId('row-address'), 'row-address');
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(row.primaryAction?.kind === 'open' ? row.primaryAction.openTarget : undefined);
        const copy = rowOverflowActions(screen).find((action) => action.id === 'copy-address');
        expect(copy).toBeTruthy();
        await act(async () => { await (copy?.onPress as () => unknown)(); });
        expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:5173');
    });

    it('ends the phone detail with the Service\'s own Stop as a destructive row, out of the menu', async () => {
        const target = projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'] });
        const onStop = vi.fn(async () => ({ status: 'succeeded' }));
        const screen = await renderScreen(
            <ServiceRowView row={projectRow(target)} presentation="detail" machineName="devbox" onStopManagedService={onStop}
                onRestartManagedService={vi.fn()} onForgetDetectedService={vi.fn()} placement={<PlacementProbe />} testID="row" />,
        );
        expect(rowOverflowActions(screen).map((action) => action.id)).toEqual(['restart', 'forget']);
        const stop = screen.findAllByType(Item).find((item) => item.props.testID === 'row-stop');
        expect(stop?.props.destructive).toBe(true);
        await pressTestInstanceAsync(screen.findByTestId('row-stop'), 'row-stop');
        expect(onStop).toHaveBeenCalledExactlyOnceWith(target);
    });

    it('keeps the phone detail\'s public-preview reason inside its sheet as a dimmed Share a link row', async () => {
        const state = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            v: 1, machineId: 'machine-a', sessionId: 'session-a', generatedAt: 4_000, refreshState: 'idle',
            policy: { enabled: false, allowedModes: [], maxTtlMs: 0, maxConcurrentExposures: 0, dnsTlsRequired: true, auditRequired: true, rateLimitProfileIds: [] },
            exposures: [], diagnostics: [],
        });
        const screen = await renderScreen(
            <ServiceRowView row={openableRow()} presentation="detail" onOpenServiceInBrowser={vi.fn()}
                publicPreviewState={state} publicPreviewActions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }} testID="row" />,
        );
        const share = screen.findAllByType(Item).find((item) => item.props.testID === 'row-share');
        expect(share?.props.disabled).toBe(true);
        expect(share?.props.subtitle).toBeTruthy();
        // The reason is that row's, not a second note drawn under the sheet.
        expect(screen.getTextContent().split(String(share?.props.subtitle)).length - 1).toBe(1);
    });

    it('ends a stopped phone detail with its own Start sheet, matching the running detail\'s Stop', async () => {
        const { row } = declaredStartRow();
        const onStart = vi.fn(async () => ({ status: 'succeeded' }));
        const screen = await renderScreen(
            <ServiceRowView row={row} presentation="detail" machineName="devbox" onStartLauncherTarget={onStart}
                placement={<PlacementProbe />} testID="row" />,
        );
        expect(screen.findAllByTestId('row-start')).toHaveLength(0);
        await pressTestInstanceAsync(screen.findByTestId('row-start-row'), 'row-start-row');
        expect(onStart).toHaveBeenCalledOnce();
    });

    it('shows and copies a wildcard-bound service as localhost, never as its bind address', async () => {
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
                    scope: 'workspace',
                    title: 'cupsd',
                    portLabel: ':631',
                    scheme: 'https',
                    host: '0.0.0.0',
                    status: 'running',
                    reasonCode: null,
                    sourceLabel: 'localServices.source.detected',
                    target,
                })}
                expanded
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );

        expect(screen.getTextContent()).not.toContain('0.0.0.0');
        await pressTestInstanceAsync(screen.findByTestId('row-copy-address'), 'row-copy-address');
        expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith('https://localhost:631');
    });

    /**
     * The row's destructive actions moved into the canonical row overflow (U-11): the row used to
     * end in up to six flat icon buttons, two of them near-identical red circles. The repo's
     * established way to assert an `ItemRowActions` menu is to read the action model it was given
     * rather than to drive its portalled popover.
     */
    function rowOverflowActions(screen: Awaited<ReturnType<typeof renderScreen>>) {
        // The component reference, not the string name: `findAllByType` matches by type identity,
        // and a string silently matches nothing for a function component.
        const menus = screen.findAllByType(ItemRowActions);
        return menus.flatMap((menu) =>
            (menu.props as { actions?: readonly Record<string, unknown>[] }).actions ?? []);
    }

    function terminateAction(screen: Awaited<ReturnType<typeof renderScreen>>) {
        return rowOverflowActions(screen).find((action) => action.id === 'terminate') ?? null;
    }

    function detectedTerminateRow() {
        const target = launchTarget({
            id: 'inventory:entry-a',
            source: 'inventory_entry',
            state: 'available',
            actions: ['terminate_detected'],
            unavailableReason: undefined,
        });
        return serviceRow({
            id: 'inventory:entry-a',
            scope: 'thisSession',
            title: 'Vite',
            status: 'running',
            reasonCode: null,
            sourceLabel: 'localServices.source.detected',
            target,
            terminateIdentityConfidence: 'pid_only',
        });
    }

    it('carries the PID-only terminate confidence on the terminate action itself', async () => {
        const screen = await renderScreen(
            <ServiceRowView
                row={detectedTerminateRow()}
                onTerminateDetectedService={vi.fn()}
                expanded
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );

        // The confidence is decision-relevant, so it belongs where the decision is made — as the
        // named action's subtitle — not as a permanent grey line in the row.
        const action = terminateAction(screen);
        expect(action).toBeTruthy();
        expect(action?.destructive).toBe(true);
        expect(String(action?.subtitle ?? '')).not.toHaveLength(0);
    });

    it('offers no terminate action when the row cannot be terminated', async () => {
        const screen = await renderScreen(
            <ServiceRowView row={serviceRow()} onTerminateDetectedService={vi.fn()} testID="row" />,
        );

        expect(terminateAction(screen)).toBeNull();
    });

    /** R2a-F12 / R2b-12: the configurable Action approval is the one consent owner; the row adds none. */
    it('terminates and stops through their Actions without a second, row-owned confirmation', async () => {
        const onTerminate = vi.fn(async () => ({ ok: true }));
        const screen = await renderScreen(
            <ServiceRowView
                row={detectedTerminateRow()}
                onTerminateDetectedService={onTerminate}
                expanded
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );

        await act(async () => {
            (terminateAction(screen)?.onPress as (() => void) | undefined)?.();
        });

        expect(modalSpies.confirm).not.toHaveBeenCalled();
        expect(onTerminate).toHaveBeenCalledOnce();
    });

    // The managed stop affordance this suite used to cover is gone: `ServiceRow.managed` was
    // only ever populated from a registry whose two start mutators had no production caller, so
    // the row it rendered could not exist on any machine (RU2 surfaces finalization, DEC-6 /
    // LSV-2). `serviceSurfaceClosure.test.ts` now guards the removal.

    function openableRow() {
        const target = launchTarget({
            id: 'preview:preview_1',
            source: 'registered_preview',
            state: 'available',
            actions: ['open'],
            unavailableReason: undefined,
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview_1',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        });
        return serviceRow({
            id: 'preview:preview_1',
            scope: 'thisSession',
            title: 'Vite',
            portLabel: ':5173',
            host: '127.0.0.1',
            status: 'running',
            reasonCode: null,
            sourceLabel: 'localServices.source.preview',
            primaryAction: { kind: 'open', openTarget: target },
            target,
        });
    }

    const exposure = {
        exposureId: 'public_preview_1',
        previewId: 'preview_1',
        sessionId: 'session-a',
        machineId: 'machine-a',
        mode: 'secret_link' as const,
        state: 'active' as const,
        publicUrl: 'https://preview.example.test/s/public_preview_1',
        issuedAt: 1_000,
        expiresAt: Date.now() + 42 * 60_000,
        auditEventIds: ['audit_1'],
        rateLimitProfileId: 'default',
    };

    function publicPreviewStateWithExposure() {
        return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            v: 1,
            machineId: 'machine-a',
            sessionId: 'session-a',
            generatedAt: 4_000,
            refreshState: 'idle',
            policy: {
                enabled: true,
                allowedModes: ['secret_link'],
                maxTtlMs: 3_600_000,
                maxConcurrentExposures: 2,
                dnsTlsRequired: true,
                auditRequired: true,
                rateLimitProfileIds: ['default'],
            },
            exposures: [exposure],
            diagnostics: [],
        });
    }

    /**
     * Lab S's signature: the row grows in place into its controls and its live public link. A
     * collapsed row draws none of that (no repeated public-preview heading down the pane, U-10);
     * only the one expanded row shows the link it owns.
     */
    /**
     * One tap (H-UX F-8, services lab O): the signature action of a running row is a trailing Open,
     * like ▶ on a row that can be started. It opens without expanding the row, and the expansion
     * does not repeat it.
     */
    it('opens a running service in one tap from the collapsed row', async () => {
        const row = openableRow();
        const onOpen = vi.fn();
        const onExpandedChange = vi.fn();
        const screen = await renderScreen(
            <ServiceRowView
                row={row}
                onOpenServiceInBrowser={onOpen}
                expanded={false}
                onExpandedChange={onExpandedChange}
                testID="row"
            />,
        );

        expect(screen.findByTestId('row-open')).not.toBeNull();
        await pressTestInstanceAsync(screen.findByTestId('row-open'), 'row-open');
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(row.primaryAction?.kind === 'open' ? row.primaryAction.openTarget : null);
        expect(onExpandedChange).not.toHaveBeenCalled();
    });

    it('keeps Stop reachable from the collapsed row beside Open, and the overflow in one place when expanded', async () => {
        const row = projectRow(projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'],
            endpointUrl: 'http://localhost:5173/',
            browserTarget: { kind: 'localServicePreview', targetId: 'preview_web', sessionId: 'session-a', machineId: 'machine-a' } }));
        const handlers = { onOpenServiceInBrowser: vi.fn(), onStopManagedService: vi.fn(), onRestartManagedService: vi.fn() };
        const collapsed = await renderScreen(<ServiceRowView row={row} machineName="devbox" {...handlers}
            expanded={false} onExpandedChange={vi.fn()} testID="row" />);
        expect(collapsed.findByTestId('row-open')).not.toBeNull();
        expect(collapsed.findByTestId('row-overflow')).not.toBeNull();
        expect(rowOverflowActions(collapsed).map((action) => action.id)).toContain('stop');
        await collapsed.unmount();

        const expanded = await renderScreen(<ServiceRowView row={row} machineName="devbox" {...handlers}
            expanded onExpandedChange={vi.fn()} testID="row" />);
        expect(expanded.findAllByType(ItemRowActions)).toHaveLength(1);
        expect(expanded.findByTestId('row-copy-address')).toBeTruthy();
    });

    it('offers Share a link in the collapsed row\'s menu, and only in the action line once expanded (RU2 J3)', async () => {
        const row = projectRow(projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'],
            endpointUrl: 'http://localhost:5173/',
            browserTarget: { kind: 'localServicePreview', targetId: 'preview_1', sessionId: 'session-a', machineId: 'machine-a' } }));
        const publicPreviewState = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            v: 1, machineId: 'machine-a', sessionId: 'session-a', generatedAt: 4_000, refreshState: 'idle',
            policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 3_600_000, maxConcurrentExposures: 2,
                dnsTlsRequired: true, auditRequired: true, rateLimitProfileIds: ['default'] },
            exposures: [], diagnostics: [],
        });
        const props = { row, machineName: 'devbox', onOpenServiceInBrowser: vi.fn(), onStopManagedService: vi.fn(),
            publicPreviewState, publicPreviewActions: { create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() },
            onExpandedChange: vi.fn(), testID: 'row' };
        const collapsed = await renderScreen(<ServiceRowView {...props} expanded={false} />);
        const share = rowOverflowActions(collapsed).find((action) => action.id === 'share');
        expect(share?.title).toBe('Share a link');
        expect(typeof share?.onPress).toBe('function');
        await collapsed.unmount();

        const expanded = await renderScreen(<ServiceRowView {...props} expanded />);
        expect(rowOverflowActions(expanded).map((action) => action.id)).not.toContain('share');
        expect(expanded.findAllByType(RoundButton).filter((button) => button.props.testID === 'row-share')).toHaveLength(1);
    });

    it('keeps one Open when the row is expanded: the expansion does not repeat it', async () => {
        const screen = await renderScreen(
            <ServiceRowView
                row={openableRow()}
                onOpenServiceInBrowser={vi.fn()}
                expanded
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );

        expect(screen.findByTestId('row-open')).not.toBeNull();
        const expansion = screen.findByTestId('row-expansion');
        expect(expansion?.findAll((node) => node.props?.testID === 'row-open')).toHaveLength(0);
        expect(screen.findByTestId('row-copy-address')).toBeTruthy();
    });

    it('keeps a collapsed row quiet and grows the expanded row into Copy address and its live link', async () => {
        const row = openableRow();
        const actions = { create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() };
        const collapsed = await renderScreen(
            <ServiceRowView
                row={row}
                onOpenServiceInBrowser={vi.fn()}
                publicPreviewState={publicPreviewStateWithExposure()}
                publicPreviewActions={actions}
                expanded={false}
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );
        expect(collapsed.findAll((node) => String(node.props?.testID ?? '').includes('public-preview'))).toHaveLength(0);
        expect(collapsed.findAllByTestId('row-copy-address')).toHaveLength(0);
        await collapsed.unmount();

        const expanded = await renderScreen(
            <ServiceRowView
                row={row}
                onOpenServiceInBrowser={vi.fn()}
                publicPreviewState={publicPreviewStateWithExposure()}
                publicPreviewActions={actions}
                expanded
                onExpandedChange={vi.fn()}
                testID="row"
            />,
        );
        expect(expanded.findByTestId('row-copy-address')).toBeTruthy();
        expect(expanded.findByTestId('row-public-preview-exposure:public_preview_1-countdown')).toBeTruthy();
        expect(expanded.getTextContent()).toContain('Public link');
        // The secret link stays masked until the user reveals it, and so does its QR code.
        expect(expanded.findAllByTestId('row-public-preview-exposure:public_preview_1-qr')).toHaveLength(0);
        await pressTestInstanceAsync(
            expanded.findByTestId('row-public-preview-exposure:public_preview_1-reveal'),
            'reveal',
        );
        expect(expanded.findByTestId('row-public-preview-exposure:public_preview_1-qr')).toBeTruthy();
    });

    it('asks to be expanded when the collapsed row is pressed', async () => {
        const onExpandedChange = vi.fn();
        const screen = await renderScreen(
            <ServiceRowView
                row={openableRow()}
                onOpenServiceInBrowser={vi.fn()}
                expanded={false}
                onExpandedChange={onExpandedChange}
                testID="row"
            />,
        );
        await pressTestInstanceAsync(screen.findByTestId('row-item'), 'row-item');
        expect(onExpandedChange).toHaveBeenCalledWith(true);
    });
    /** Plan 22 §2 / lab s-services: Project declarations through the one row model. */
    function projectTarget(overrides: Partial<LocalServiceLaunchTarget> = {}): LocalServiceLaunchTarget {
        return launchTarget({ id: 'project-service:jobs', source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'owned-jobs' },
            workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted', rootPath: '/repo' },
            declaration: { workspaceRefId: 'accepted', selection: { kind: 'native',
                source: { kind: 'native', tool: 'procfile', file: 'Procfile', target: 'jobs' } } },
            title: 'jobs', unavailableReason: undefined, ...overrides });
    }
    function projectRow(target: LocalServiceLaunchTarget) {
        return buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' })[0]!;
    }

    it('reads a never-started declaration as Ready to start: its command, its file chip and no status word', async () => {
        const row = projectRow(projectTarget({ commandPreview: 'yarn storybook', declaration: { workspaceRefId: 'accepted',
            selection: { kind: 'native', source: { kind: 'native', tool: 'package_script', file: 'apps/ui/package.json', target: 'storybook' } } } }));
        const screen = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={vi.fn()} machineName="devbox" testID="row" />);
        const text = screen.getTextContent();
        expect(text).toContain('yarn storybook');
        // One quiet line: the command, then the declaring file as the same source chip a running row
        // draws (lab s-services), and "Ready to start" (the section) says it has not started.
        expect(screen.findByTestId('row-source')).toBeTruthy();
        expect(text).toContain('yarn storybook ·');
        expect(text).toContain('package.json');
        expect(text).not.toContain('not started');
        expect(text).not.toContain('Unavailable');
        expect(text).not.toContain("can't be started");
        expect(screen.findAllByTestId('row-dot')).toHaveLength(0);
        expect(screen.findByTestId('row-start')).toBeTruthy();
    });

    it('says a live service with no endpoint has no address and keeps Restart, Stop and Hide on the row', async () => {
        const target = projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'] });
        const row = projectRow(target);
        const onStop = vi.fn(async () => ({ status: 'succeeded' }));
        const onRestart = vi.fn(async () => ({ status: 'succeeded' }));
        const screen = await renderScreen(<ServiceRowView row={row} machineName="devbox" onStopManagedService={onStop}
            onRestartManagedService={onRestart} onForgetDetectedService={vi.fn()} expanded={false} onExpandedChange={vi.fn()} testID="row" />);
        const text = screen.getTextContent();
        expect(text).toContain('No address');
        expect(text).toContain('Procfile');
        expect(text).toContain('on devbox');
        // Nothing to grow into: the overflow is the row's own control, not an empty expansion.
        expect(screen.findAllByTestId('row-expansion')).toHaveLength(0);
        expect(rowOverflowActions(screen).map((action) => action.id)).toEqual(['restart', 'stop', 'forget']);

        await act(async () => { (rowOverflowActions(screen).find((a) => a.id === 'stop')?.onPress as () => void)(); });
        expect(modalSpies.confirm).not.toHaveBeenCalled();
        expect(onStop).toHaveBeenCalledExactlyOnceWith(target);
        await act(async () => { (rowOverflowActions(screen).find((a) => a.id === 'restart')?.onPress as () => void)(); });
        expect(onRestart).toHaveBeenCalledExactlyOnceWith(target);
    });

    // CA2-02: a native occurrence whose state is unknown, or stopped while its starter tree is still
    // owned, is not Running. The row says so and keeps Stop for cleanup; nothing offers a fresh Start.
    it.each(['managed_service_native_state_unknown', 'managed_service_native_cleanup_unconfirmed'] as const)(
        'never reads unsettled native custody (%s) as Running and keeps Stop without Start or Restart', async (reason) => {
            const target = projectTarget({ state: 'available', serviceState: 'unhealthy', actions: ['manage'],
                unavailableReason: reason, endpointUrl: 'http://localhost:5173/' });
            const row = projectRow(target);
            const onStop = vi.fn(async () => ({ status: 'succeeded' }));
            const screen = await renderScreen(<ServiceRowView row={row} machineName="devbox" onStopManagedService={onStop}
                onRestartManagedService={vi.fn()} onStartLauncherTarget={vi.fn()} onForgetDetectedService={vi.fn()}
                expanded onExpandedChange={vi.fn()} testID="row" />);
            const text = screen.getTextContent();
            expect(text).not.toContain('Running');
            expect(text).toContain('Unknown');
            expect(screen.findByTestId('row-reason')).toBeTruthy();
            expect(screen.findByTestId('row-start')).toBeNull();
            expect(rowOverflowActions(screen).map((action) => action.id)).toEqual(['stop', 'forget']);
            await act(async () => { (rowOverflowActions(screen).find((a) => a.id === 'stop')?.onPress as () => void)(); });
            expect(onStop).toHaveBeenCalledExactlyOnceWith(target);
        });

    it('offers no Stop for a settled lifetime and names a failed start as Failed', async () => {
        const row = projectRow(projectTarget({ state: 'available', serviceState: 'failed', actions: ['manage'] }));
        const screen = await renderScreen(<ServiceRowView row={row} onStopManagedService={vi.fn()} onRestartManagedService={vi.fn()}
            onStartLauncherTarget={vi.fn()} testID="row" />);
        expect(screen.findByTestId('row-status-failed')).toBeTruthy();
        expect(rowOverflowActions(screen).map((action) => action.id)).not.toContain('stop');
    });

    it('offers a failed start\'s sanitized output behind Review output, and nothing once it recovers', async () => {
        const diagnostics = [{ code: 'native_service_output', severity: 'info', message: 'EADDRINUSE: address already in use :::3005' }] as const;
        const failed = projectRow(projectTarget({ state: 'available', serviceState: 'failed', actions: ['manage'], diagnostics: [...diagnostics] }));
        const screen = await renderScreen(<ServiceRowView row={failed} onStartLauncherTarget={vi.fn()} testID="row" />);
        // Failed is said once, by the status beside the name, not again as a tail.
        expect(screen.findByTestId('row-status-failed')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('Service could not start.');
        expect(screen.getTextContent()).toContain('Review output');
        // The output stays closed until asked for, and a code never stands in for a sentence.
        expect(screen.getTextContent()).not.toContain('EADDRINUSE');
        await pressTestInstanceAsync(screen.findByTestId('row-output-toggle'), 'row-output-toggle');
        expect(screen.getTextContent()).toContain('EADDRINUSE: address already in use :::3005');

        const recovered = projectRow(projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'] }));
        const after = await renderScreen(<ServiceRowView row={recovered} testID="row" />);
        expect(after.findByTestId('row-output-toggle')).toBeNull();
        expect(after.getTextContent()).not.toContain('Review output');

        const bare = projectRow(projectTarget({ state: 'available', serviceState: 'failed', actions: ['manage'] }));
        const quiet = await renderScreen(<ServiceRowView row={bare} onStartLauncherTarget={vi.fn()} testID="row" />);
        expect(quiet.findByTestId('row-output-toggle')).toBeNull();
    });

    it('does not offer the previous attempt\'s output while a retry is starting', async () => {
        const diagnostics = [{ code: 'native_service_output', severity: 'info', message: 'EADDRINUSE: address already in use :::3005' }] as const;
        const retrying = projectRow(projectTarget({ state: 'starting', actions: ['manage'], diagnostics: [...diagnostics] }));
        const screen = await renderScreen(<ServiceRowView row={retrying} testID="row" />);
        expect(screen.findByTestId('row-status-starting')).toBeTruthy();
        expect(screen.findByTestId('row-output-toggle')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Review output');
    });

    it('retains the published failure until the daemon admits the retry', async () => {
        const diagnostics = [{ code: 'native_service_output', severity: 'info', message: 'EADDRINUSE: address already in use :::3005' }] as const;
        const failed = projectRow(projectTarget({ state: 'available', serviceState: 'failed', actions: ['manage'], diagnostics: [...diagnostics] }));
        const start = vi.fn(() => new Promise<unknown>(() => {}));
        const screen = await renderScreen(<ServiceRowView row={failed} onStartLauncherTarget={start} testID="row" />);
        expect(screen.findByTestId('row-output-toggle')).toBeTruthy();
        await act(async () => { void pressTestInstanceAsync(screen.findByTestId('row-start'), 'row-start'); });
        expect(screen.findByTestId('row-status-starting')).toBeNull();
        expect(screen.findByTestId('row-status-failed')).toBeTruthy();
        expect(screen.findByTestId('row-output-toggle')).toBeTruthy();
    });

    /**
     * R2a-F2 / R2b-01: Runs on is reachable from every service row. A never-started declaration and
     * a live worker with no address grow into their placement; the worker keeps its overflow on the row.
     */
    it('grows a never-started declaration into its Runs on without starting anything', async () => {
        const row = projectRow(projectTarget({ actions: ['start'] }));
        const onExpandedChange = vi.fn();
        const onStart = vi.fn();
        const collapsed = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={onStart}
            placement={<PlacementProbe />} expanded={false} onExpandedChange={onExpandedChange} testID="row" />);
        await pressTestInstanceAsync(collapsed.findByTestId('row-item'), 'row-item');
        expect(onExpandedChange).toHaveBeenCalledWith(true);
        expect(onStart).not.toHaveBeenCalled();

        const open = await renderScreen(<ServiceRowView row={row} onStartLauncherTarget={onStart}
            placement={<PlacementProbe />} expanded onExpandedChange={vi.fn()} testID="row" />);
        expect(open.findByTestId('row-expansion')).toBeTruthy();
        expect(open.findByTestId('placement-probe')).toBeTruthy();
        expect(open.findByTestId('row-start')).toBeTruthy();
    });

    it('keeps a live no-address worker\'s controls on the row and opens into its Runs on', async () => {
        const row = projectRow(projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'] }));
        const screen = await renderScreen(<ServiceRowView row={row} machineName="devbox" onStopManagedService={vi.fn()}
            onRestartManagedService={vi.fn()} onForgetDetectedService={vi.fn()} placement={<PlacementProbe />}
            expanded onExpandedChange={vi.fn()} testID="row" />);
        expect(screen.findByTestId('placement-probe')).toBeTruthy();
        expect(screen.findAllByTestId('row-copy-address')).toHaveLength(0);
        // One overflow, on the row itself (lab `jobs`), never repeated inside the expansion.
        expect(screen.findAllByType(ItemRowActions)).toHaveLength(1);
        expect(rowOverflowActions(screen).map((action) => action.id)).toEqual(['restart', 'stop', 'forget']);
    });

    /** R2a-F13: the feed's start time and starter, never a name invented from a bare id. */
    it('says how long a service has run and who started it when that is someone else', async () => {
        const startedAtMs = Date.now() - 42 * 60_000;
        const own = projectRow(projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'],
            startedAtMs, startedByAccountId: 'viewer-account' }));
        const ownScreen = await renderScreen(<ServiceRowView row={own} machineName="devbox"
            startedByName={null} testID="row" />);
        expect(ownScreen.getTextContent()).toContain('42 min');
        expect(ownScreen.getTextContent()).not.toContain('ago');
        expect(ownScreen.getTextContent()).not.toContain('Started by');

        const teammate = projectRow(projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'],
            startedAtMs, startedByAccountId: 'ana-account' }));
        const named = await renderScreen(<ServiceRowView row={teammate} machineName="build-01"
            startedByName="Ana" testID="row" />);
        expect(named.getTextContent()).toContain('Started by Ana on build-01');
        const unnamed = await renderScreen(<ServiceRowView row={teammate} machineName="build-01"
            startedByName={null} testID="row" />);
        expect(unnamed.getTextContent()).not.toContain('ana-account');
        expect(unnamed.getTextContent()).toContain('on build-01');
    });

    it('does not repeat a detected process\'s name in its facts line', async () => {
        // Owner screenshot 2026-10-30 16:53: "node ● Running" over "localhost:35681 · node · on NLDW6".
        const row = serviceRow({ scope: 'machine', title: 'node', processLabel: 'node', serviceLabel: 'node',
            addressLabel: 'localhost:35681', status: 'running', reasonCode: null,
            target: launchTarget({ state: 'available', unavailableReason: undefined }) });
        const screen = await renderScreen(<ServiceRowView row={row} machineName="NLDW6" testID="row" />);
        expect(collectMetaText(screen.findByTestId('row-meta')!).replace(/\s+/g, ' ').trim()).toBe('localhost:35681 · on NLDW6');
    });

    it('labels every status as last known while the machine is offline', async () => {
        const row = projectRow(projectTarget({ state: 'available', serviceState: 'running', actions: ['manage'], endpointUrl: 'http://127.0.0.1:3005/' }));
        const screen = await renderScreen(<ServiceRowView row={row} offline machineName="devbox" testID="row" />);
        const text = screen.getTextContent();
        expect(text).toContain('Last known');
        expect(text).not.toContain('Running');
        expect(text).toContain('localhost:3005');
    });

    /**
     * Services lab R: a Service seen from another device. Whether this device can open the private
     * preview is the preview access owner's answer (`accessUnavailableReasonCode`); the row consumes
     * it, so a control that cannot succeed is never shown and the way that works leads instead.
     */
    describe('seen from a device that cannot open it', () => {
        function unreachablePreviews(): LocalServicePreviewState {
            const resource = { previewId: 'preview_1' } as LocalServicePreviewRow['resource'];
            return {
                ...createLocalServicePreviewState(),
                generatedAt: 4_000,
                previewIds: ['preview_1'],
                previewsById: new Map([['preview_1', {
                    previewId: 'preview_1', resource, accessUrl: null, expiresAt: null,
                    accessUnavailableReasonCode: 'preview_private_route_unavailable', diagnostics: [],
                }]]),
            };
        }
        function shareablePublicPreviewState() {
            return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
                v: 1, machineId: 'machine-a', sessionId: 'session-a', generatedAt: 4_000, refreshState: 'idle',
                policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 3_600_000, maxConcurrentExposures: 2,
                    dnsTlsRequired: true, auditRequired: true, rateLimitProfileIds: ['default'] },
                exposures: [], diagnostics: [],
            });
        }
        const publicActions = () => ({ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() });

        it('offers no Open or Copy address, says where it runs, and leads with Share a link', async () => {
            const screen = await renderScreen(
                <ServiceRowView row={openableRow()} machineName="MacBook Pro" previews={unreachablePreviews()}
                    onOpenServiceInBrowser={vi.fn()} publicPreviewState={shareablePublicPreviewState()}
                    publicPreviewActions={publicActions()} expanded onExpandedChange={vi.fn()} testID="row" />,
            );
            expect(screen.findAllByTestId('row-open')).toHaveLength(0);
            expect(screen.findAllByTestId('row-copy-address')).toHaveLength(0);
            expect(collectMetaText(screen.findByTestId('row-elsewhere')!)).toContain('MacBook Pro');
            // The way that works from here is the expansion's one primary, not a secondary beside Copy address.
            const share = screen.findAllByType(RoundButton).find((button) => button.props.testID === 'row-share');
            expect(share?.props.display).toBe('default');
        });

        it('still expands when the only thing to show is where it runs and that links are off', async () => {
            const onExpandedChange = vi.fn();
            const screen = await renderScreen(
                <ServiceRowView row={{ ...openableRow(), host: null, portLabel: null }} machineName="MacBook Pro"
                    previews={unreachablePreviews()} onOpenServiceInBrowser={vi.fn()} expanded
                    onExpandedChange={onExpandedChange} testID="row" />,
            );
            expect(screen.findAllByTestId('row-open')).toHaveLength(0);
            expect(screen.findAllByTestId('row-share')).toHaveLength(0);
            expect(screen.findByTestId('row-elsewhere')).toBeTruthy();
        });

        it('keeps Open while the preview answer is not in yet', async () => {
            const screen = await renderScreen(
                <ServiceRowView row={openableRow()} previews={createLocalServicePreviewState()}
                    onOpenServiceInBrowser={vi.fn()} expanded={false} onExpandedChange={vi.fn()} testID="row" />,
            );
            expect(screen.findByTestId('row-open')).not.toBeNull();
        });

        it('on the phone detail, Address copies and Share a link is the pinned primary, drawn once', async () => {
            const onOpen = vi.fn();
            const screen = await renderScreen(
                <ServiceRowView row={{ ...openableRow(), scheme: 'http' as const }} presentation="detail" machineName="MacBook Pro"
                    previews={unreachablePreviews()} onOpenServiceInBrowser={onOpen}
                    publicPreviewState={shareablePublicPreviewState()} publicPreviewActions={publicActions()} testID="row" />,
            );
            const address = screen.findAllByType(Item).find((item) => item.props.testID === 'row-address');
            expect(address?.props.showChevron).toBe(false);
            expect(String(address?.props.subtitle)).toContain('MacBook Pro');
            await pressTestInstanceAsync(screen.findByTestId('row-address'), 'row-address');
            expect(onOpen).not.toHaveBeenCalled();
            expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledWith('http://127.0.0.1:5173');
            expect(screen.findByTestId('row-pinned')?.findAll((node) => node.props?.testID === 'row-share').length).toBeGreaterThan(0);
            expect(screen.findAllByType(Item).filter((item) => item.props.testID === 'row-share')).toHaveLength(0);
        });
    });
});

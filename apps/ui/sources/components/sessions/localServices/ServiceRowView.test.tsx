import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
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
        terminateIdentityConfidence: null,
        target,
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

describe('ServiceRowView', () => {
    beforeEach(() => {
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
        clipboardSpies.setClipboardStringSafe.mockClear();
        clipboardSpies.setClipboardStringSafe.mockResolvedValue(true);
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

        expect(dotHaloBackground(screen)).toBe('transparent');
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

    it('confirms before terminating a detected service and cancels cleanly when declined', async () => {
        const onTerminate = vi.fn();
        modalSpies.confirm.mockResolvedValueOnce(false);

        const screen = await renderScreen(
            <ServiceRowView
                row={detectedTerminateRow()}
                onTerminateDetectedService={onTerminate}
                testID="row"
            />,
        );

        const action = terminateAction(screen);
        await act(async () => {
            (action?.onPress as (() => void) | undefined)?.();
        });

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(onTerminate).not.toHaveBeenCalled();
    });

    // The managed stop affordance this suite used to cover is gone: `ServiceRow.managed` was
    // only ever populated from a registry whose two start mutators had no production caller, so
    // the row it rendered could not exist on any machine (RU2 surfaces finalization, DEC-6 /
    // LSV-2). `serviceSurfaceClosure.test.ts` now guards the removal.

    /**
     * Public-preview controls are no longer mounted per row.
     *
     * They were rendered inside EVERY qualifying row, which repeated the group heading down the
     * pane and made `activeExposureCount` rescan the whole exposure set once per row (U-10). The
     * group is now mounted once at pane level, so the capability is preserved and relocated, not
     * removed — `DetectedLocalServicesPane.test.tsx` owns its coverage. The row must no longer
     * render any exposure affordance of its own.
     */
    it('renders no public-preview affordance of its own', async () => {
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
                testID="row"
            />,
        );

        expect(screen.findAll((node) => String(node.props?.testID ?? '').includes('public-preview'))).toHaveLength(0);
        expect(screen.findAll((node) => String(node.props?.testID ?? '').endsWith('-create'))).toHaveLength(0);
        // The row still shows the service itself: the address is the control now, mono and copyable.
        expect(screen.findByTestId('row-copy-address')).toBeTruthy();
        expect(screen.getTextContent()).toContain('127.0.0.1:5173');
    });
});

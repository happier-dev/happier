import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

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

describe('ServiceRowView', () => {
    it('shows a ready script without a running or stopped status badge', async () => {
        const target = launchTarget({ state: 'available', actions: ['start'], sourceClass: { kind: 'package_script', packageName: 'docs', scriptName: 'dev', runTargetId: 'docs:dev' }, commandPreview: 'yarn docs:dev' });
        const screen = await renderScreen(<ServiceRowView row={serviceRow({ target, status: 'stopped', reasonCode: null, processLabel: 'yarn docs:dev', primaryAction: { kind: 'run_script', target } })} onStartLauncherTarget={() => {}} testID="row" />);
        expect(screen.findByTestId('row-dot')).toBeNull();
        expect(screen.findByTestId('row-status-stopped')).toBeNull();
        expect(screen.findByTestId('row-start')).toBeTruthy();
        expect(screen.getTextContent()).toContain('yarn docs:dev');
    });

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
        const screen = await renderScreen(
            <ServiceRowView row={serviceRow({ status: 'starting', reasonCode: null })} testID="row" />,
        );

        expect(dotStyle(screen).opacity).toBeDefined();
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

    it('confirms before terminating a detected service and cancels cleanly when declined', async () => {
        const onTerminate = vi.fn();
        modalSpies.confirm.mockResolvedValueOnce(false);

        const screen = await renderScreen(
            <ServiceRowView
                row={detectedTerminateRow()}
                onTerminateDetectedService={onTerminate}
                expanded
                onExpandedChange={vi.fn()}
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
});

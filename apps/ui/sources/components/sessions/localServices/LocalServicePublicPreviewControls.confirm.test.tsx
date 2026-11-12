import * as React from 'react';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    LocalServiceLaunchTargetV1} from '@happier-dev/protocol/local/services/launcher/v1';
import type {
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol/local/services/public/v1';

import { renderWithAppProviders } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

import { LocalServicePublicPreviewControls, resolveLocalServicePublicLinkOffer } from './LocalServicePublicPreviewControls';
import { storage } from '@/sync/domains/state/storage';
import { createBrowserWorkspaceOpeningFixture } from '@/dev/testkit/fixtures/browserWorkspaceOpening';
import { createLocalServicesRuntimeActionExecutor } from '@/sync/domains/local/services/actions/runtimeActionExecutor';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createLocalServicePublicPreviewActions } from './publicPreviewActions';

const executeOnMachine = vi.fn<RuntimeActionExecute>();
// The Account Action transport and modal host are genuine boundaries; Action admission,
// preview registration, public-preview actions and control logic remain real.

const originalSettings = storage.getState().settings;
afterEach(() => storage.setState({ settings: originalSettings }));

const modalSpies = vi.hoisted(() => ({
    alert: vi.fn<IModal['alert']>(),
    confirm: vi.fn<IModal['confirm']>(async () => true),
    alertAsync: vi.fn<IModal['alertAsync']>(async () => {}),
    show: vi.fn<IModal['show']>(() => 'modal-id'),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: modalSpies.alert, confirm: modalSpies.confirm, alertAsync: modalSpies.alertAsync, show: modalSpies.show },
    }).module;
});

type ExposureSheetProps = Readonly<{
    modeChoices: readonly { mode: string; label: string }[];
    ttlChoices: readonly { ttlMs: number; label: string }[];
    onResolve: (decision: { mode: string; ttlMs: number } | null) => void;
}>;

/**
 * Let the create chain settle.
 *
 * The create control's `onPress` returns immediately — the flow is a detached async IIFE (sheet →
 * decision → `runner.run` → `actions.create`), so pressing and asserting in the same tick sees a
 * spy that has not been called yet. This drains the microtask queue those awaits sit on.
 */
async function flushCreateChain(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** The props the component handed the consequence sheet on its most recent create press. */
function lastExposureSheetProps(): ExposureSheetProps {
    const call = modalSpies.show.mock.calls.at(-1);
    const config = call?.[0] as unknown as Readonly<{ props?: ExposureSheetProps }> | undefined;
    if (!config?.props) throw new Error('the consequence sheet was never shown');
    return config.props;
}

/**
 * Answer the consequence sheet the next time it is shown.
 *
 * The create flow is ONE `Modal.show` card now, not `Modal.confirm` followed by two `alertAsync`
 * choice prompts (F0 §3.D): the user reads the three consequences and picks the lifetime and link
 * type in the same moment they commit. `chooseTtlIndex` picks from the lifetimes the component
 * actually offered, so the test asserts the policy-narrowed choice rather than restating a constant.
 * Pass `null` to back out, which must create nothing.
 */
function answerExposureSheet(answer: null | { chooseTtlIndex?: number; chooseModeIndex?: number }): void {
    modalSpies.show.mockImplementationOnce((config) => {
        // `Modal.show`'s config is generic over any custom modal component, so it does not overlap
        // this sheet's concrete props type. Narrowing through `unknown` at the mocked-boundary is
        // the only honest route; the shape is asserted immediately below by using every field.
        const props = (config as unknown as Readonly<{ props: ExposureSheetProps }>).props;
        if (answer === null) {
            props.onResolve(null);
            return 'modal-id';
        }
        const mode = props.modeChoices[answer.chooseModeIndex ?? 0];
        const ttl = props.ttlChoices[answer.chooseTtlIndex ?? 0];
        props.onResolve(mode && ttl ? { mode: mode.mode, ttlMs: ttl.ttlMs } : null);
        return 'modal-id';
    });
}

const target = {
    id: 'preview:preview_1',
    source: 'registered_preview',
    machineId: 'machine_1',
    sessionId: 'session_1',
    title: 'Dashboard',
    confidence: 'high',
    state: 'available',
    actions: [],
    browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
    },
} satisfies LocalServiceLaunchTargetV1;

const snapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    previewId: 'preview_1',
    generatedAt: 2_000,
    refreshState: 'idle',
    policy: {
        enabled: true,
        allowedModes: ['secret_link'],
        maxTtlMs: 600_000,
        maxConcurrentExposures: 1,
        dnsTlsRequired: true,
        auditRequired: true,
        rateLimitProfileIds: ['default'],
    },
    exposures: [],
    diagnostics: [],
} satisfies LocalServicePublicPreviewSnapshotV1;

const previewState = applyLocalServicePublicPreviewSnapshot(
    createLocalServicePublicPreviewState(),
    snapshot,
);

const activeDifferentPreviewExposure = {
    exposureId: 'public_preview_2',
    previewId: 'preview_2',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'secret_link',
    state: 'active',
    publicUrl: 'https://preview.example.test/s/public_preview_2',
    issuedAt: 1_000,
    expiresAt: 601_000,
    auditEventIds: ['audit_2'],
    rateLimitProfileId: 'default',
} satisfies LocalServicePublicExposureV1;

const limitReachedPreviewState = applyLocalServicePublicPreviewSnapshot(
    createLocalServicePublicPreviewState(),
    {
        ...snapshot,
        exposures: [activeDifferentPreviewExposure],
    },
);

const activeCurrentPreviewExposure = {
    ...activeDifferentPreviewExposure,
    exposureId: 'public_preview_1',
    previewId: 'preview_1',
    publicUrl: 'https://preview.example.test/s/public_preview_1',
} satisfies LocalServicePublicExposureV1;

const activePreviewState = applyLocalServicePublicPreviewSnapshot(
    createLocalServicePublicPreviewState(),
    {
        ...snapshot,
        exposures: [activeCurrentPreviewExposure],
    },
);

const policyDisabledPreviewState = applyLocalServicePublicPreviewSnapshot(
    createLocalServicePublicPreviewState(),
    {
        ...snapshot,
        policy: {
            ...snapshot.policy,
            enabled: false,
        },
    },
);

const dnsTlsDisabledPreviewState = applyLocalServicePublicPreviewSnapshot(
    createLocalServicePublicPreviewState(),
    {
        ...snapshot,
        refreshState: 'error',
        policy: {
            ...snapshot.policy,
            enabled: false,
        },
        diagnostics: [{
            v: 1,
            code: 'public_policy_denied',
            severity: 'error',
            scope: 'publicPreview',
            previewId: 'preview_1',
            emittedAtMs: 2_000,
            details: {
                reasonCode: 'dns_tls_unavailable',
            },
        }],
    },
);

function findCreatePressable(result: Awaited<ReturnType<typeof renderWithAppProviders>>) {
    return result.tree.root.findAll((node) =>
        node.props?.testID === 'local-service-public-preview-controls-target:preview_1-create'
        && typeof node.props?.onPress === 'function')[0];
}

describe('LocalServicePublicPreviewControls (consequence sheet before create)', () => {
    beforeEach(() => {
        modalSpies.alert.mockReset();
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
        modalSpies.alertAsync.mockReset();
        modalSpies.alertAsync.mockImplementation(async () => {});
        modalSpies.show.mockReset();
        modalSpies.show.mockImplementation(() => 'modal-id');
        executeOnMachine.mockReset();
    });

    it('does not offer Share for a Ready managed Service without registration intent', () => {
        const ready = { ...target, source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'managed_1' },
            cwd: '/workspace/web', sessionId: undefined, browserTarget: undefined, actions: ['manage'],
        } satisfies LocalServiceLaunchTargetV1;
        expect(resolveLocalServicePublicLinkOffer({ state: previewState, launchTarget: ready })).toBeNull();
    });

    it.each([true, false])('registers a running Sessionless Service before offering sharing choices (registration enabled=%s)', async (registrationEnabled) => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: 'machine_1', managedServiceId: 'managed_1',
            workspaceId: 'workspace_1', cwd: '/workspace/web',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } };
        // Same typed shape captured from #54: running, register_preview, no private preview or Session.
        const launchTarget = { ...target, id: 'managed:managed_1', source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'managed_1' }, serviceState: 'running',
            actions: ['manage', 'register_preview'], browserTarget: undefined, sessionId: undefined,
            cwd: serviceTarget.cwd, declaration: serviceTarget.declaration, workspaceId: serviceTarget.workspaceId,
        } satisfies LocalServiceLaunchTargetV1;
        const resource = { previewId: 'preview_1', machineId: 'machine_1', serviceTarget,
            owner: { kind: 'user', id: 'account_1' }, target: { scheme: 'http', host: '127.0.0.1', port: 42514 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Dashboard', addressLabel: 'localhost:42514' }, originMode: 'host' } as const;
        const preview = { previewId: resource.previewId, resource, expiresAt: 61_000, diagnostics: [] };
        executeOnMachine.mockResolvedValue({ protocolVersion: 1, status: 'created', preview,
            snapshot: { v: 1, machineId: 'machine_1', generatedAt: 1_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] } });
        const openDetailsTab = vi.fn();
        const fixture = createBrowserWorkspaceOpeningFixture({ openDetailsTab, scope: 'workspaceDetails', platform: 'web' }, {
            isActionEnabled: id => id !== 'localServices.preview.openOrCreate' || registrationEnabled,
            runtimeActionExecute: createLocalServicesRuntimeActionExecutor({ executeOnMachine }),
        });
        const runtimeActionExecute = createFrontDoorRuntimeActionExecutor({
            execute: (id, input, context) => fixture.executor.execute(id, input, { ...context, ...fixture.context }),
        });
        const actions = createLocalServicePublicPreviewActions({ runtimeActionExecute, serverId: fixture.context.serverId,
            expectedAccountId: 'account_1', copyToClipboard: async () => false });
        const state = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            ...snapshot, policy: { ...snapshot.policy, allowedModes: ['secret_link', 'people'] },
        });
        storage.setState({ settings: { ...originalSettings, actionsSettingsV1: {
            v: 1, actions: {}, approvalWaivedSurfaces: { 'localServices.publicPreview.create': ['ui'] },
        } } });
        answerExposureSheet(null);
        const result = await renderWithAppProviders(<LocalServicePublicPreviewControls launchTargets={[launchTarget]} state={state} actions={actions} />);
        try {
            const share = result.tree.root.findAll(node => node.props?.testID === 'local-service-public-preview-controls-target:managed:managed_1-create'
                && typeof node.props.onPress === 'function')[0];
            expect(share, 'a running register_preview Service must offer Share before its first Open').toBeTruthy();
            const { act } = await import('react-test-renderer');
            await act(async () => {
                await share.props.onPress();
                await vi.waitFor(() => {
                    if (registrationEnabled) {
                        expect(modalSpies.alert.mock.calls, 'registration must succeed before the exposure sheet').toEqual([]);
                        expect(modalSpies.show).toHaveBeenCalledTimes(1);
                    } else expect(modalSpies.alert).toHaveBeenCalled();
                });
            });
            if (registrationEnabled) {
                expect(lastExposureSheetProps().modeChoices.map(choice => choice.mode)).toEqual(['secret_link', 'people']);
                expect(executeOnMachine).toHaveBeenCalledWith(expect.objectContaining({
                    actionId: 'localServices.preview.openOrCreate',
                    input: { machineId: 'machine_1', serviceTarget },
                }));
            } else {
                expect(modalSpies.show).not.toHaveBeenCalled();
                expect(executeOnMachine).not.toHaveBeenCalled();
            }
            expect(openDetailsTab).not.toHaveBeenCalled();
        } finally {
            await result.unmount();
            fixture.dispose();
        }
    });

    it('states the consequences and creates only what the sheet returned', async () => {
        const create = vi.fn(async () => undefined);

        answerExposureSheet({});

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[]}
                browserTarget={target.browserTarget}
                serviceTitle={target.title}
                state={previewState}
                actions={{ create, copyUrl: vi.fn(async () => true), revoke: vi.fn(async () => undefined) }}
            />,
        );

        const pressable = findCreatePressable(result);
        expect(pressable).toBeTruthy();
        await pressable.props.onPress();
        await flushCreateChain();

        // ONE dialog, not three. The old flow was `confirm` → mode `alertAsync` → ttl `alertAsync`,
        // which asked the user to commit before telling them what they were committing to.
        expect(modalSpies.show).toHaveBeenCalledTimes(1);
        expect(modalSpies.confirm).not.toHaveBeenCalled();
        expect(modalSpies.alertAsync).not.toHaveBeenCalled();

        // The sheet names the service and is the surface that carries the consent.
        const config = modalSpies.show.mock.calls[0]?.[0] as Readonly<{
            chrome?: Readonly<{ subtitle?: string }>;
        }>;
        expect(config.chrome?.subtitle).toContain('Dashboard');

        // The policy admits exactly one lifetime here, so the sheet offers exactly that one and the
        // exposure shape is explicit rather than a hard-coded 10 minutes.
        expect(create).toHaveBeenCalledWith(target.browserTarget, { mode: 'secret_link', ttlMs: 600_000 });
        await result.unmount();
    });

    it('creates nothing when the user backs out of the sheet', async () => {
        const create = vi.fn(async () => undefined);

        answerExposureSheet(null);

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={previewState}
                actions={{ create, copyUrl: vi.fn(async () => true), revoke: vi.fn(async () => undefined) }}
            />,
        );

        const pressable = findCreatePressable(result);
        await pressable.props.onPress();

        await flushCreateChain();

        expect(modalSpies.show).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
        await result.unmount();
    });

    it('offers the modes admitted by the server policy', async () => {
        const create = vi.fn(async () => undefined);
        answerExposureSheet({ chooseModeIndex: 1 });
        const state = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            ...snapshot,
            policy: { ...snapshot.policy, allowedModes: ['secret_link', 'public'] },
        });
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls launchTargets={[target]} state={state}
                actions={{ create, copyUrl: vi.fn(async () => true), revoke: vi.fn(async () => undefined) }} />,
        );
        try {
            await findCreatePressable(result).props.onPress();
            await flushCreateChain();
            expect(lastExposureSheetProps().modeChoices.map(choice => choice.mode)).toEqual(['secret_link', 'public']);
            expect(create).toHaveBeenCalledWith(target, { mode: 'public', ttlMs: 600_000 });
        } finally { await result.unmount(); }
    });

    it('honours the UI create waiver with the current policy-admitted link choices', async () => {
        storage.setState({ settings: { ...originalSettings, actionsSettingsV1: {
            v: 1, actions: {}, approvalWaivedSurfaces: { 'localServices.publicPreview.create': ['ui'] },
        } } });
        const create = vi.fn(async () => undefined);
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls launchTargets={[target]} state={previewState}
                actions={{ create, copyUrl: vi.fn(async () => true), revoke: vi.fn() }} />,
        );
        await findCreatePressable(result).props.onPress();
        await flushCreateChain();
        expect(modalSpies.show).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(target, { mode: 'secret_link', ttlMs: 600_000 });
        await result.unmount();
    });

    it('keeps public preview controls visible with a disabled reason when the exposure limit is reached', async () => {
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={limitReachedPreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
            />,
        );

        expect(result.tree.root.findByProps({
            testID: 'local-service-public-preview-controls-target:preview_1-disabled',
        })).toBeTruthy();
        const reason = result.tree.root.findByProps({
            testID: 'local-service-public-preview-controls-target:preview_1-disabled',
        });
        // The reason is a sentence, never a raw protocol id.
        expect(String(reason.props.children)).not.toContain('secret_link');
        await result.unmount();
    });

    it('keeps public preview controls visible with a disabled reason when policy disables creation', async () => {
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={policyDisabledPreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
            />,
        );

        expect(result.tree.root.findByProps({
            testID: 'local-service-public-preview-controls-target:preview_1-disabled',
        })).toBeTruthy();
        await result.unmount();
    });

    it('surfaces the server disabled reason instead of the generic policy fallback', async () => {
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={dnsTlsDisabledPreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
            />,
        );

        const text = result.tree.toJSON();
        expect(JSON.stringify(text)).toContain('DNS/TLS');
        expect(JSON.stringify(text)).not.toContain('Public previews are disabled for this service.');
        await result.unmount();
    });

    it('disables creation when the Home has no allowed tunnel ports', async () => {
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={policyDisabledPreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
                capabilityDisabledReasons={{ preview: [], publicPreview: ['pms_allowed_ports_empty'] }}
            />,
        );

        expect(findCreatePressable(result)).toBeUndefined();
        expect(result.tree.root.findByProps({
            testID: 'local-service-public-preview-controls-target:preview_1-disabled',
        })).toBeTruthy();
        await result.unmount();
    });

    it('lets the user choose the link lifetime within the server policy (UB-4)', async () => {
        const create = vi.fn(async () => undefined);
        const generousPolicyState = applyLocalServicePublicPreviewSnapshot(
            createLocalServicePublicPreviewState(),
            { ...snapshot, policy: { ...snapshot.policy, maxTtlMs: 24 * 60 * 60_000 } },
        );

        answerExposureSheet({ chooseTtlIndex: 1 }); // the second offered lifetime: 1 hour

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={generousPolicyState}
                actions={{ create, copyUrl: vi.fn(async () => true), revoke: vi.fn(async () => undefined) }}
            />,
        );

        await findCreatePressable(result).props.onPress();
        await flushCreateChain();

        // A generous ceiling opens up real choice, and the sheet offers it inline rather than as a
        // second dialog. The user's pick is what reaches the daemon.
        expect(lastExposureSheetProps().ttlChoices.length).toBeGreaterThan(1);
        expect(create).toHaveBeenCalledWith(target, { mode: 'secret_link', ttlMs: 60 * 60_000 });
        await result.unmount();
    });

    it('offers only the lifetimes the server policy admits', async () => {
        const create = vi.fn(async () => undefined);

        answerExposureSheet({});

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={previewState}
                actions={{ create, copyUrl: vi.fn(async () => true), revoke: vi.fn(async () => undefined) }}
            />,
        );

        await findCreatePressable(result).props.onPress();

        await flushCreateChain();
        // `maxTtlMs` is 10 minutes on this policy, so a longer lifetime must never be offered —
        // the ceiling is the server's, and the sheet may not invite a choice the daemon will refuse.
        const offered = lastExposureSheetProps().ttlChoices.map((choice) => choice.ttlMs);
        expect(offered.length).toBeGreaterThan(0);
        expect(Math.max(...offered)).toBeLessThanOrEqual(600_000);
        await result.unmount();
    });

    it('shows the remaining lifetime of a live exposure instead of an open-ended "active" (G15)', async () => {
        const now = Date.now();
        const liveState = applyLocalServicePublicPreviewSnapshot(
            createLocalServicePublicPreviewState(),
            {
                ...snapshot,
                exposures: [{
                    ...activeCurrentPreviewExposure,
                    issuedAt: now - 60_000,
                    expiresAt: now + 30 * 60_000,
                }],
            },
        );

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={liveState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
            />,
        );

        const countdown = result.tree.root.findByProps({
            testID: 'local-service-public-preview-controls-exposure:public_preview_1-countdown',
        });
        expect(String(countdown.props.children)).toContain('29');
        await result.unmount();
    });

    /**
     * F-PLAN-22: the live countdown is presentation. In a retained pane that is hidden (a closed
     * right-sidebar tab keeps its rows mounted) it stops ticking; shown again, it reads the clock anew.
     */
    it('stops ticking the countdown while its pane is hidden and ticks while it is shown', async () => {
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { act } = await import('react-test-renderer');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        try {
            const start = new Date('2026-10-01T10:00:00.000Z').getTime();
            vi.setSystemTime(start);
            const liveState = applyLocalServicePublicPreviewSnapshot(
                createLocalServicePublicPreviewState(),
                {
                    ...snapshot,
                    exposures: [{ ...activeCurrentPreviewExposure, issuedAt: start - 60_000, expiresAt: start + 30 * 60_000 }],
                },
            );
            const renderIn = async (active: boolean) => await renderWithAppProviders(
                <PluginSurfaceFocusEligibilityProvider active={active}>
                    <LocalServicePublicPreviewControls
                        launchTargets={[target]}
                        state={liveState}
                        actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
                    />
                </PluginSurfaceFocusEligibilityProvider>,
            );
            const countdownText = (result: Awaited<ReturnType<typeof renderWithAppProviders>>) => String(result.tree.root.findByProps({
                testID: 'local-service-public-preview-controls-exposure:public_preview_1-countdown',
            }).props.children);

            const hidden = await renderIn(false);
            const hiddenBefore = countdownText(hidden);
            await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
            expect(countdownText(hidden)).toBe(hiddenBefore);
            await hidden.unmount();

            vi.setSystemTime(start);
            const shown = await renderIn(true);
            const shownBefore = countdownText(shown);
            await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
            expect(countdownText(shown)).not.toBe(shownBefore);
            await shown.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops claiming a lapsed exposure is active and refuses to copy a dead link (G15)', async () => {
        const now = Date.now();
        const lapsedState = applyLocalServicePublicPreviewSnapshot(
            createLocalServicePublicPreviewState(),
            {
                ...snapshot,
                exposures: [{
                    ...activeCurrentPreviewExposure,
                    issuedAt: now - 20 * 60_000,
                    expiresAt: now - 60_000,
                }],
            },
        );

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={lapsedState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
            />,
        );

        const rendered = JSON.stringify(result.tree.toJSON());
        expect(rendered).toContain('Link expired');
        expect(rendered).not.toContain('Shareable link active');
        const copy = result.tree.root.findAll((node) =>
            node.props?.testID === 'local-service-public-preview-controls-exposure:public_preview_1-copy'
            && node.props?.disabled !== undefined)[0];
        expect(copy?.props.disabled).toBe(true);
        await result.unmount();
    });

    it('renders the active exposure mode as localized product copy, not a raw protocol id', async () => {
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={activePreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
            />,
        );

        // What the issued link allows is a sentence ("Anyone who has the link…"), not the protocol id.
        expect(result.tree.root.findAll((node) => typeof node.props?.children === 'string'
            && node.props.children.includes('Anyone who has the link can open'))).not.toHaveLength(0);
        expect(result.tree.root.findAll((node) => node.props?.children === 'secret_link')).toHaveLength(0);
        await result.unmount();
    });

    it('titles a people share for its audience, never as a public link', async () => {
        const peopleState = applyLocalServicePublicPreviewSnapshot(
            createLocalServicePublicPreviewState(),
            {
                ...snapshot,
                policy: { ...snapshot.policy, allowedModes: ['secret_link', 'people'] },
                exposures: [{ ...activeCurrentPreviewExposure, mode: 'people',
                    audience: [{ kind: 'account', accountId: 'account_b' }] }],
            },
        );
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={peopleState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
            />,
        );
        const texts = result.tree.root.findAll((node) => typeof node.props?.children === 'string')
            .map((node) => node.props.children as string);
        expect(texts).toContain('Link for specific people');
        expect(texts.some((text) => /public link/i.test(text))).toBe(false);
        await result.unmount();
    });
});

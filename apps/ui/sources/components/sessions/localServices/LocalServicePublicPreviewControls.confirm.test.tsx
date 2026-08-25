import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    LocalServiceLaunchTargetV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';

import { renderWithAppProviders } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

import { LocalServicePublicPreviewControls } from './LocalServicePublicPreviewControls';

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn<IModal['confirm']>(async () => true),
    alertAsync: vi.fn<IModal['alertAsync']>(async () => {}),
    show: vi.fn<IModal['show']>(() => 'modal-id'),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { confirm: modalSpies.confirm, alertAsync: modalSpies.alertAsync, show: modalSpies.show },
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

function findRevokePressable(result: Awaited<ReturnType<typeof renderWithAppProviders>>) {
    return result.tree.root.findAll((node) =>
        node.props?.testID === 'local-service-public-preview-controls-exposure:public_preview_1-revoke'
        && typeof node.props?.onPress === 'function')[0];
}

describe('LocalServicePublicPreviewControls (consequence sheet before create)', () => {
    beforeEach(() => {
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
        modalSpies.alertAsync.mockReset();
        modalSpies.alertAsync.mockImplementation(async () => {});
        modalSpies.show.mockReset();
        modalSpies.show.mockImplementation(() => 'modal-id');
    });

    it('states the consequences and creates only what the sheet returned', async () => {
        const create = vi.fn(async () => undefined);

        answerExposureSheet({});

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
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
        expect(create).toHaveBeenCalledWith(target, { mode: 'secret_link', ttlMs: 600_000 });
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

        expect(modalSpies.show).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
        await result.unmount();
    });

    it('only revokes an active public preview after confirmation is accepted', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const revoke = vi.fn(async () => undefined);

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={activePreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke }}
            />,
        );

        const pressable = findRevokePressable(result);
        expect(pressable).toBeTruthy();
        await pressable.props.onPress();

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        const confirmationCall = modalSpies.confirm.mock.calls[0] as Parameters<IModal['confirm']> | undefined;
        // The confirm quotes the MASKED link, never the secret one: a revoke prompt is often read
        // aloud or shown on a shared screen, and the whole point of revoking is that the secret has
        // travelled far enough already.
        expect(confirmationCall?.[1]).toContain('https://preview.example.test/');
        expect(confirmationCall?.[1]).not.toContain('public_preview_1');
        expect(revoke).toHaveBeenCalledExactlyOnceWith(activeCurrentPreviewExposure);
        await result.unmount();
    });

    it('does not revoke an active public preview when confirmation is declined', async () => {
        modalSpies.confirm.mockResolvedValueOnce(false);
        const revoke = vi.fn(async () => undefined);

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={activePreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke }}
            />,
        );

        await findRevokePressable(result).props.onPress();

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(revoke).not.toHaveBeenCalled();
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
        const mode = result.tree.root.findByProps({
            testID: 'local-service-public-preview-controls-target:preview_1-disabled-mode',
        });
        expect(mode.props.children).not.toBe('secret_link');
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

    it('names the unmet server prerequisite the surface owner resolved, not the generic sentence', async () => {
        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={policyDisabledPreviewState}
                actions={{ create: vi.fn(), copyUrl: vi.fn(async () => true), revoke: vi.fn() }}
                capabilityDisabledReasons={{ preview: [], publicPreview: ['pms_allowed_ports_empty'] }}
            />,
        );

        const text = JSON.stringify(result.tree.toJSON());
        expect(text).toContain('The server allows no tunnel ports.');
        expect(text).not.toContain('Public previews are disabled for this service.');
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

        const mode = result.tree.root.findByProps({
            testID: 'local-service-public-preview-controls-exposure:public_preview_1-mode',
        });
        expect(mode.props.children).not.toBe('secret_link');
        await result.unmount();
    });
});

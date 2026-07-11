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

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn<IModal['confirm']>(async () => true),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalSpies.confirm } }).module;
});

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

describe('LocalServicePublicPreviewControls (UX-5 confirm before create)', () => {
    beforeEach(() => {
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
    });

    it('only calls create after the confirmation is accepted', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const create = vi.fn(async () => undefined);
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

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

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        const confirmationCall = modalSpies.confirm.mock.calls[0] as Parameters<IModal['confirm']> | undefined;
        expect(confirmationCall?.[1]).toContain('Dashboard');
        expect(confirmationCall?.[1]).toContain('publicly reachable');
        expect(create).toHaveBeenCalledWith(target);
        await result.unmount();
    });

    it('does not call create when the confirmation is declined', async () => {
        modalSpies.confirm.mockResolvedValueOnce(false);
        const create = vi.fn(async () => undefined);
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

        const result = await renderWithAppProviders(
            <LocalServicePublicPreviewControls
                launchTargets={[target]}
                state={previewState}
                actions={{ create, copyUrl: vi.fn(async () => true), revoke: vi.fn(async () => undefined) }}
            />,
        );

        const pressable = findCreatePressable(result);
        await pressable.props.onPress();

        expect(modalSpies.confirm).toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        await result.unmount();
    });

    it('only revokes an active public preview after confirmation is accepted', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const revoke = vi.fn(async () => undefined);
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

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
        expect(confirmationCall?.[1]).toContain('https://preview.example.test/s/public_preview_1');
        expect(revoke).toHaveBeenCalledExactlyOnceWith(activeCurrentPreviewExposure);
        await result.unmount();
    });

    it('does not revoke an active public preview when confirmation is declined', async () => {
        modalSpies.confirm.mockResolvedValueOnce(false);
        const revoke = vi.fn(async () => undefined);
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

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
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

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
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

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
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

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

    it('renders the active exposure mode as localized product copy, not a raw protocol id', async () => {
        const { LocalServicePublicPreviewControls } = await import('./LocalServicePublicPreviewControls');

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

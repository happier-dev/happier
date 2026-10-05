import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { getActiveServerId, upsertServerProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { loadEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import type { IModal } from '@/modal';

const spies = vi.hoisted(() => ({
    push: vi.fn(),
    switchServer: vi.fn(async (_input: unknown) => 'switched' as const),
    showModal: vi.fn<IModal['show']>(() => 'modal-id'),
}));
const viewport = vi.hoisted(() => ({ klass: 'medium' as 'compact' | 'medium' }));

vi.mock('@/utils/platform/useViewportClass', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/useViewportClass')>(),
    useViewportClass: () => viewport.klass,
    readViewportClass: () => viewport.klass,
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useDeviceType: () => viewport.klass === 'compact' ? 'phone' : 'tablet',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/', router: { push: spies.push } }).module;
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: spies.showModal } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => params
            ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
            : key,
    });
});

// Focusing a Home reconnects this device's live transport to it: the process boundary this sheet
// crosses. Which Home is focused, and what follows, stay real.
vi.mock('@/sync/domains/server/activeServerSwitch', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/server/activeServerSwitch')>()),
    setActiveServerAndSwitch: spies.switchServer,
}));

function home(id: string, name: string, url: string): ServerProfile {
    return { id, name, serverUrl: url, serverIdentityId: `srv_${id}`, createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
}

const studio = home('studio', 'Studio Home', 'https://studio.example.test');
const personal = home('personal', 'Personal Home', 'http://127.0.0.1:4100');

// Load the real owner graph before the interaction deadline starts.
await import('./ReconcileHomesSheet');
await import('@/modal/components/CustomModal');

describe('ReconcileHomesContent', () => {
    beforeEach(() => {
        viewport.klass = 'medium';
        spies.push.mockClear();
        spies.switchServer.mockClear();
        spies.showModal.mockClear();
    });

    it('presents a phone bottom sheet with its own visible title and preamble', async () => {
        viewport.klass = 'compact';
        const { presentReconcileHomesSheet } = await import('./ReconcileHomesSheet');
        const { CustomModal } = await import('@/modal/components/CustomModal');
        const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
        presentReconcileHomesSheet({ foundCount: 2 });
        const config = spies.showModal.mock.calls[0]![0];
        const screen = await renderScreen(<CustomModal config={{ ...config, id: 'reconcile-phone', type: 'custom' }} onClose={() => {}} visible />);

        expect(screen.findByType(ModalCardFrame).props.presentation).toBe('sheet');
        expect(screen.findAll((node) => node.props.children === 'homesJourneys.phone.reconcileTitle').length).toBeGreaterThan(0);
        expect(screen.findAll((node) => node.props.children === 'homesJourneys.phone.reconcileLead').length).toBeGreaterThan(0);
        await screen.unmount();
    });

    it('shows the phone its sessions across Homes without configuring this computer or changing its active Home', async () => {
        viewport.klass = 'compact';
        const settle = vi.fn();
        const onClose = vi.fn();
        const { ReconcileHomesContent } = await import('./ReconcileHomesSheet');
        const savedStudio = await upsertServerProfile({ serverUrl: studio.serverUrl, name: studio.name });
        const savedPersonal = await upsertServerProfile({ serverUrl: personal.serverUrl, name: personal.name });
        const activeAtEntry = getActiveServerId();
        const screen = await renderScreen(<ReconcileHomesContent found={[savedStudio]} personal={savedPersonal} settle={settle} onClose={onClose} />);

        expect(Boolean(screen.findByTestId('reconcile-homes.run-in'))).toBe(false);
        expect(Boolean(screen.findByTestId('reconcile-homes.keep-both'))).toBe(false);
        await screen.pressByTestIdAsync('reconcile-homes.show-sessions');
        expect(loadEffectiveHomeViewState()).toMatchObject({ activeTargetKind: 'group', activeTargetId: '@all-homes' });
        expect(getActiveServerId()).toBe(activeAtEntry);
        expect(settle).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
        expect(spies.switchServer).not.toHaveBeenCalled();
        expect(spies.push).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('keeps both Homes: settles the choice and changes nothing else', async () => {
        const settle = vi.fn();
        const onClose = vi.fn();
        const { ReconcileHomesContent } = await import('./ReconcileHomesSheet');
        const screen = await renderScreen(<ReconcileHomesContent found={[studio]} personal={personal} settle={settle} onClose={onClose} />);

        await screen.pressByTestIdAsync('reconcile-homes.keep-both');
        expect(settle).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
        expect(spies.switchServer).not.toHaveBeenCalled();
        expect(spies.push).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('uses the found Home: focuses it and hands this computer to its setup for that Home', async () => {
        const settle = vi.fn();
        const onClose = vi.fn();
        const { ReconcileHomesContent } = await import('./ReconcileHomesSheet');
        const screen = await renderScreen(<ReconcileHomesContent found={[studio]} personal={personal} settle={settle} onClose={onClose} />);

        expect(screen.findAllByTestId('reconcile-homes.use').find((node) => node.props.title !== undefined)?.props.title).toBe('homesJourneys.useHome(home=Studio Home)');
        await screen.pressByTestIdAsync('reconcile-homes.use');
        expect(settle).toHaveBeenCalledOnce();
        expect(spies.switchServer).toHaveBeenCalledWith({ serverId: 'studio', scope: 'device' });
        expect(spies.push).toHaveBeenCalledWith('/settings/machines/add?path=thisComputer');
        await screen.unmount();
    });

    it('never offers to remove the Personal Home while the Home has not said it is empty', async () => {
        const { ReconcileHomesContent } = await import('./ReconcileHomesSheet');
        const screen = await renderScreen(<ReconcileHomesContent found={[studio]} personal={personal} settle={() => {}} onClose={() => {}} />);

        expect(screen.findByTestId('homes-journeys.remove-empty-personal-home')).toBeFalsy();
        await screen.unmount();
    });
});

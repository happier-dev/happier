import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { motionTokens } from '@/components/ui/motion/motionTokens';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The Radix DOM leaf is the system boundary; modal custody and detail rendering stay real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
type ModalEntries = ReturnType<typeof useModal>['state']['modals'];
let entries: ModalEntries = [];
function ObserveModals() {
    entries = useModal().state.modals;
    return null;
}

describe('openActionOperationDetail', () => {
    beforeEach(() => {
        actionOperationStore.reset();
        entries = [];
    });
    afterEach(async () => {
        await standardCleanup();
        await homes.reset();
        vi.useRealTimers();
        actionOperationStore.reset();
    });

    it('opens the shared live detail by exact Home-qualified operation address', async () => {
        const { openActionOperationDetail } = await import('./openActionOperationDetail');
        for (const serverId of ['home-a', 'home-b']) actionOperationStore.mergeSnapshots({ serverId, snapshots: [{
            version: 1, operationId: 'operation-1', revision: 1, actionId: 'acme.preview/deploy', state: 'succeeded',
            scope: { accountId: 'account', machineId: 'machine' }, title: 'Deploy', createdAt: 1, settledAt: 2,
            cancellation: 'unsupported', result: { destination: serverId === 'home-a' ? 'Alpha destination' : 'Beta destination' },
        }] });
        const screen = await renderScreen(React.createElement(ModalProvider, null, React.createElement(ObserveModals)));
        await act(async () => {
            expect(openActionOperationDetail({ serverId: 'home-a', operationId: 'operation-1' })).toBeUndefined();
                await vi.dynamicImportSettled();
        });

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            type: 'custom',
            visible: true,
            props: { serverId: 'home-a', operationId: 'operation-1' },
            closeOnBackdrop: true,
            accessibilityLabel: 'inbox.actionOperations.detailAccessibilityLabel',
        });
        expect(screen.getTextContent()).toContain('Alpha destination');
        expect(screen.getTextContent()).not.toContain('Beta destination');
        vi.useFakeTimers();
        await screen.pressByTestIdAsync('action-operation-done');
        expect(entries.filter(entry => 'visible' in entry && entry.visible === true)).toHaveLength(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.overlay.modal.exitMs); });
        expect(screen.findAllByType(ActionOperationDetailModal)).toHaveLength(0);
    });

    it('does not open detail for an unqualified legacy operation', async () => {
        const { openActionOperationDetail } = await import('./openActionOperationDetail');
        await renderScreen(React.createElement(ModalProvider, null, React.createElement(ObserveModals)));
        await act(async () => openActionOperationDetail({ serverId: null, operationId: 'operation-1' }));

        expect(entries).toEqual([]);
    });
});

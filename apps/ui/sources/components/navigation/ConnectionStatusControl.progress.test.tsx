import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { invokeTestInstanceHandler, renderScreen, pressTestInstanceAsync, standardCleanup } from '@/dev/testkit';
import { installBrowserClipboardBoundary } from '@/dev/testkit/harness/browserClipboardBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The native clipboard is the system boundary under the copy Action.
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
const initialState = storage.getState();

afterEach(async () => {
    standardCleanup();
    await homes.reset();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(initialState, true);
});

describe('ConnectionStatusControl retry progress', () => {
    it('keeps retry feedback on the real Home lifecycle across details, failure and recovery', async () => {
        await homes.reset();
        const homeId = await homes.addHome({ name: 'Studio', serverUrl: 'https://studio.test', accountId: 'studio-account' });
        storage.getState().activateProfileScope({ serverId: homeId, accountId: 'studio-account' });
        storage.getState().applyMachines([], true, { sourceServerId: homeId, sourceAccountId: 'studio-account' });
        storage.getState().markMachineListSettled(homeId);
        const retryAt = Date.now() + 60_000;
        storage.setState({ socketStatus: 'disconnected', endpointStatus: 'offline', endpointNextRetryAt: retryAt, syncError: null });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ConnectionStatusControl variant="fullScreen" />
        </InjectedAuthProvider>);
        const accountPage = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ConnectionStatusControl variant="page" />
        </InjectedAuthProvider>);
        const homeRetryId = `connection-popover-home-server-${homeId}-fix`;
        expect(accountPage.findByTestId(homeRetryId)).not.toBeNull();
        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('connection-details-disclosure'));
        });
        expect(screen.findByTestId('connection-popover-next-retry')).not.toBeNull();

        await act(async () => {
            storage.setState({ endpointStatus: 'connecting', endpointNextRetryAt: null });
        });
        // A Home being retried keeps Retry pressable: a user's retry supersedes a silent dial or probe.
        const isPressable = (nodes: ReadonlyArray<{ type: unknown; props: { accessibilityState?: { busy?: boolean; disabled?: boolean } } }>) => {
            const hosts = nodes.filter(node => typeof node.type === 'string');
            return hosts.length > 0 && hosts.every(node => node.props.accessibilityState?.busy !== true && node.props.accessibilityState?.disabled !== true);
        };
        expect(isPressable(screen.findAllByTestId('connection-popover-primary-action'))).toBe(true);
        expect(isPressable(accountPage.findAllByTestId(homeRetryId))).toBe(true);
        expect(screen.findByTestId('connection-popover-next-retry')).toBeNull();

        await act(async () => {
            storage.setState({ endpointStatus: 'offline', endpointNextRetryAt: retryAt });
        });
        expect(screen.findByTestId('connection-popover-next-retry')).not.toBeNull();
        await act(async () => {
            storage.setState({ endpointStatus: 'online', endpointNextRetryAt: null, socketStatus: 'connected' });
        });
        expect(screen.findByTestId('connection-popover-next-retry')).toBeNull();
        expect(screen.findAllByTestId('connection-popover-primary-action').filter(node => typeof node.type === 'string')).toHaveLength(0);
        expect(accountPage.findAllByTestId(homeRetryId).filter(node => typeof node.type === 'string')).toHaveLength(0);

        // A staged/unavailable runtime must not expose the previous transport's retry deadline.
        await act(async () => {
            storage.setState({ endpointStatus: 'offline', endpointNextRetryAt: retryAt });
            publishAppliedActiveServerRuntimeAvailability(false);
        });
        expect(screen.findByTestId('connection-popover-next-retry')).toBeNull();
    });
});

describe('ConnectionStatusControl connection details', () => {
    async function renderStudioDetails() {
        await homes.reset();
        const homeId = await homes.addHome({ name: 'Studio', serverUrl: 'https://studio.test', accountId: 'studio-account' });
        storage.getState().activateProfileScope({ serverId: homeId, accountId: 'studio-account' });
        storage.getState().applyMachines([], true, { sourceServerId: homeId, sourceAccountId: 'studio-account' });
        storage.getState().markMachineListSettled(homeId);
        await homes.setActionPolicy(homeId, 'clipboard.write', 'ui', 'allowed');
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        return renderScreen(<InjectedAuthProvider credentials={null}>
            <ConnectionStatusControl variant="fullScreen" />
        </InjectedAuthProvider>);
    }

    it('says when the Home last synced as a relative time and keeps the exact time one hover or long-press away', async () => {
        const syncedAt = Date.now() - 5_000;
        storage.setState({ socketStatus: 'connected', endpointStatus: 'online', syncError: null, lastSyncAt: syncedAt });
        const screen = await renderStudioDetails();

        const exact = new Date(syncedAt).toLocaleString();
        expect(screen.getTextContent()).toContain('Synced just now');
        expect(screen.getTextContent()).not.toContain(exact);
        const lastSync = screen.findByTestId('connection-popover-last-sync');
        expect(lastSync?.props.accessibilityLabel).toContain(exact);
        if (Platform.OS === 'web') {
            await act(async () => lastSync?.props.onHoverIn?.());
            await act(async () => { await import('@/components/ui/overlays/AnchoredTooltip'); });
            expect(screen.findByTestId('connection-popover-last-sync-tooltip')).not.toBeNull();
        } else {
            await act(async () => lastSync?.props.onLongPress?.());
            expect(screen.getTextContent()).toContain(exact);
        }
    });

    it('keeps technical facts behind one disclosure, copies a value on tap, and ends with Copy diagnostics', async () => {
        const writeText = vi.fn(async (_value: string) => undefined);
        installBrowserClipboardBoundary(writeText);
        storage.setState({ socketStatus: 'connected', endpointStatus: 'online', syncError: null, lastSyncAt: Date.now() });
        const screen = await renderStudioDetails();

        expect(screen.getTextContent()).not.toContain('Canonical address');
        expect(screen.findByTestId('connection-copy-diagnostics')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Technical details');

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('connection-details-disclosure'));
        });

        expect(screen.getTextContent()).toContain('Canonical address');
        // The surface is already titled Connection details: no second heading inside it.
        expect(screen.getTextContent()).not.toContain('Connection Details');
        // The shared row's copy: a tap on the web, a long-press on a phone.
        const canonicalRow = screen.findByTestId('connection-transport-canonicalAddress');
        if (!canonicalRow) throw new Error('expected the canonical address row');
        if (Platform.OS === 'web') {
            await act(async () => { await pressTestInstanceAsync(canonicalRow); });
            expect(writeText).toHaveBeenLastCalledWith('https://studio.test/');
        } else {
            const Clipboard = await import('expo-clipboard');
            await act(async () => { invokeTestInstanceHandler(canonicalRow, 'onLongPress', {}); });
            await vi.waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('https://studio.test/'));
        }
        await vi.waitFor(() => expect(screen.findByTestId('item-copy-feedback')).not.toBeNull());
    });
});

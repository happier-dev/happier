import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { arrangeMachineDetailsHomeForTests, initializeMachineDetailsRuntimeForTests } from './machineDetailsRuntimeHarness';

installTerminalRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: { id: 'machine-missing' } }).module,
});
const network = await initializeMachineDetailsRuntimeForTests();
const MachineDetailScreen = (await import('@/app/(app)/machine/[id]')).default;

let home: Awaited<ReturnType<typeof arrangeMachineDetailsHomeForTests>> | undefined;
let deferred: ReturnType<typeof createDeferred<readonly Machine[]>> | undefined;
afterEach(async () => {
    deferred?.resolve([]);
    deferred = undefined;
    await standardCleanup();
    await home?.dispose();
    home = undefined;
    network.resetRequests();
});

describe('MachineDetailScreen hydration', () => {
    it('keeps its header and loading state until the actual machine refresh supplies the missing row', async () => {
        home = await arrangeMachineDetailsHomeForTests(network, { serverUrl: 'https://machine-hydration-pending.example.test' });
        deferred = createDeferred<readonly Machine[]>();
        home.state.readMachines = () => deferred!.promise;
        const beforeRequests = home.state.machineListRequests;
        const screen = await home.render(MachineDetailScreen);
        await vi.waitFor(() => expect(home!.state.machineListRequests).toBeGreaterThan(beforeRequests));
        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('machine.notFound');
        expect(screen.findAllByProps({ testID: 'machine-detail-header' }).length).toBeGreaterThan(0);
        await act(async () => {
            deferred!.resolve([createMachineFixture({
                id: 'machine-missing', activeAt: Date.now(),
                metadata: { ...createMachineFixture().metadata!, displayName: 'Recovered Machine', host: 'host', platform: 'darwin' },
            })]);
            await flushHookEffects({ cycles: 2, turns: 2 });
        });
        await vi.waitFor(() => expect(home!.storage.getState().machines['machine-missing']?.metadata?.displayName,
            JSON.stringify({ machines: home!.storage.getState().machines, scope: home!.storage.getState().profileScope,
                lists: home!.storage.getState().machineListByServerId })).toBe('Recovered Machine'));
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('common.loading'));
        expect(screen.getTextContent()).not.toContain('machine.notFound');
        expect(home.storage.getState().machines['machine-missing']?.metadata?.displayName).toBe('Recovered Machine');
    });

    it('retains the page header with not-found after a real successful empty refresh', async () => {
        home = await arrangeMachineDetailsHomeForTests(network, { serverUrl: 'https://machine-hydration-empty.example.test' });
        const screen = await home.render(MachineDetailScreen);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('machine.notFound'));
        expect(screen.findAllByProps({ testID: 'machine-detail-header' }).length).toBeGreaterThan(0);
    });

    it('retries an unavailable machine without using the pull-to-refresh spinner', async () => {
        const offline = createMachineFixture({
            id: 'machine-missing', active: false, activeAt: Date.now() - 86_400_000,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Offline Machine', host: 'host', platform: 'darwin' },
        });
        home = await arrangeMachineDetailsHomeForTests(network, {
            serverUrl: 'https://machine-hydration-offline.example.test', machines: [offline],
        });
        expect(home.storage.getState().machines['machine-missing']?.metadata?.displayName,
            JSON.stringify({ machines: home.storage.getState().machines, scope: home.storage.getState().profileScope,
                lists: home.storage.getState().machineListByServerId })).toBe('Offline Machine');
        const screen = await home.render(MachineDetailScreen);
        await vi.waitFor(() => expect(screen.findByTestId('machine-detail-unavailable')).not.toBeNull());
        deferred = createDeferred<readonly Machine[]>();
        home.state.readMachines = () => deferred!.promise;
        const beforeRequests = home.state.machineListRequests;
        const action = () => screen.findAllByProps({ testID: 'machine-detail-unavailable' })[0]!.props.action;
        const refreshing = () => screen.tree.root.findAll(node => Boolean(node.props.refreshControl))[0]!.props.refreshControl.props.refreshing;
        expect(action().loading).toBeFalsy();
        await act(async () => { action().onPress(); await flushHookEffects({ cycles: 1, turns: 1 }); });
        await vi.waitFor(() => expect(home!.state.machineListRequests).toBeGreaterThan(beforeRequests));
        expect(action().loading).toBe(true);
        expect(refreshing()).toBe(false);
        await act(async () => { deferred!.resolve([offline]); await flushHookEffects({ cycles: 2, turns: 2 }); });
        await vi.waitFor(() => expect(action().loading).toBe(false));
        expect(refreshing()).toBe(false);
    });
});

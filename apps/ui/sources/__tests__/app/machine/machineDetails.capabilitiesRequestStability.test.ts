import { afterEach, describe, expect, it } from 'vitest';
import { createMachineFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { arrangeMachineDetailsHomeForTests, initializeMachineDetailsRuntimeForTests } from './machineDetailsRuntimeHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { CHECKLIST_IDS } from '@/sync/api/capabilities/checklistIds';

const route = { params: { id: 'machine-1' } as Record<string, string> };
installTerminalRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => route.params }).module,
});
const network = await initializeMachineDetailsRuntimeForTests();
const MachineDetailScreen = (await import('@/app/(app)/machine/[id]')).default;
const { CAPABILITIES_REQUEST_MACHINE_DETAILS } = await import('@/capabilities/requests');

let home: Awaited<ReturnType<typeof arrangeMachineDetailsHomeForTests>> | undefined;
afterEach(async () => {
    await standardCleanup();
    await home?.dispose();
    home = undefined;
    route.params = { id: 'machine-1' };
    network.resetRequests();
});

const detailsRequests = () => network.requests.filter(request =>
    request.method === RPC_METHODS.CAPABILITIES_DETECT
    && request.payload !== null && typeof request.payload === 'object'
    && 'checklistId' in request.payload && request.payload.checklistId === CHECKLIST_IDS.MACHINE_DETAILS,
);

describe('MachineDetailScreen capabilities request', () => {
    it('loads the canonical checklist without issuing another detection on unchanged renders', async () => {
        home = await arrangeMachineDetailsHomeForTests(network, {
            serverUrl: 'https://machine-capabilities-stable.example.test',
            machines: [createMachineFixture({ activeAt: Date.now() })],
        });
        network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {} });
        const screen = await home.render(MachineDetailScreen);
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(detailsRequests()).toHaveLength(1);
        expect(detailsRequests()[0]).toMatchObject({ serverUrl: home.home.serverUrl, targetId: 'machine-1', payload: CAPABILITIES_REQUEST_MACHINE_DETAILS });
        expect(screen.findAllByProps({ testID: 'machine-detail-header' }).length).toBeGreaterThan(0);
        await screen.update(home.element(MachineDetailScreen));
        await flushHookEffects({ cycles: 3, turns: 2 });
        await screen.update(home.element(MachineDetailScreen));
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(detailsRequests()).toHaveLength(1);
    });

    it('detects capabilities on the requested Home rather than the previously focused Home', async () => {
        home = await arrangeMachineDetailsHomeForTests(network, {
            serverUrl: 'https://machine-capabilities-focused.example.test',
            machines: [createMachineFixture({ activeAt: Date.now() })],
        });
        const target = await network.addHome('https://machine-capabilities-requested.example.test', 'machine-viewer');
        route.params = { id: 'machine-1', serverId: target.id };
        network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {} });
        const screen = await home.render(MachineDetailScreen);
        await flushHookEffects({ cycles: 6, turns: 3 });
        expect(detailsRequests().length).toBeGreaterThan(0);
        expect(detailsRequests().every(request => request.serverUrl === target.serverUrl && request.token === target.token)).toBe(true);
        expect(screen.findAllByProps({ testID: 'machine-detail-header' }).length).toBeGreaterThan(0);
    });
});

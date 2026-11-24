import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiActionControlRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

// Account/Action HTTP, Machine RPC and native presentation are system boundaries.
const daemonRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemonRpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await import('./defaultActionExecutor');
const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');

describe('physical control dispatch on a scoped Machine mount', () => {
    beforeEach(async () => { await homes.reset(); daemonRpc.mockReset(); });
    afterEach(() => standardCleanup());

    it('dispatches the first mounted control press from its exact Machine before AppShell discovers the declaration', async () => {
        const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { createBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { createHydratedPlainMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const serverIdentityId = 'srv_mounted_machine';
        const accountId = 'alice';
        const serverId = await homes.addHome({ name: 'Mounted Machine Home', serverUrl: 'https://mounted-machine.test',
            serverIdentityId, accountId, currentAccount: true, accountEncryptionMode: 'plain' });
        const machineId = 'mounted-machine';
        const pluginId = 'example.mounted';
        const action = { pluginId, localId: 'read' };
        const executionOrigin = { serverIdentityId, materializationRef: { machineId, pluginId, materializationId: 'current' } };
        const declaration = PluginProjectedActionV2Schema.parse({ id: action.localId, pluginId, title: 'Read',
            scopes: ['global', 'machine'], surfaces: ['ui'], execution: { target: 'daemon' },
            dangerLevel: 'safe', readOnly: true, occurrenceId: 'mounted:current', available: true });
        const projection = { v: 2, generation: 1,
            actionsById: { [`${pluginId}/${action.localId}`]: { ...declaration, executionOrigin } } };
        await answerExternalActionAccountForHome(homes, serverId, { actionId: 'action.invoke', tokenEpoch: 0,
            machineId, installationId: 'mounted-installation', execute: () => ({ rows: ['current'] }) });
        await publishMachineInventoryForTest({ serverId, accountId }, [
            createHydratedPlainMachineFixture({ id: machineId, accountId }),
        ]);
        const held = createDeferred<void>();
        const projectionRequested = createDeferred<void>();
        daemonRpc.mockImplementation(async (request: { method: string; machineId: string }) => {
            expect(request.machineId).toBe(machineId);
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                projectionRequested.resolve();
                await held.promise;
                return { protocolVersion: 1, projection };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true,
                inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };
            throw new Error(`Unanswered Machine boundary: ${request.method}`);
        });
        const withdraw = publishCommittedAppShellPluginUiProjection(() => EMPTY_PLUGIN_UI_PROJECTION);
        const unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface, hostAction, readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        }));
        const controller = createBoundPluginSurfaceController({ facts: {
            pluginId, contributionId: 'console', surfaceId: 'surfacePlacement:example.mounted:console',
            placement: 'browserSurface', platform: 'web', channel: 'internal', serverId, machineId,
            occurrenceId: declaration.occurrenceId, executionOrigin,
            accountLifetime: { scope: { serverId, accountId }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            interactionEnabled: true, daemonInteractionEnabled: true, resourceCapability: { readable: true, dynamic: true },
            resolveContributedAction: identity => identity.localId === action.localId ? declaration : null,
        } });
        let settlement: Promise<unknown> | undefined;
        let press: Promise<void> | undefined;
        try {
            const controls = controller.actionControls;
            if (!controls) throw new Error('Expected mounted controls');
            const request = (payload: PluginUiActionControlRequestV1) => ({ version: 1 as const, requestId: 'host-request',
                surface: controller.surfaceContext, method: 'actionControl' as const, payload: projectNativeJsonValueForTransport(payload) });
            const bound = await controller.hostApi.handleRequest(request({ kind: 'bind', action, subscriptionId: 'run',
                presentation: { title: 'Run' } }), { actionControlSubscription: {
                retain() {},
                publish(event) {
                    if (event.kind === 'prepare') settlement = Promise.resolve(controller.hostApi.handleRequest(request({
                        kind: 'prepared', subscriptionId: 'run', requestId: event.requestId, preparation: { input: {} },
                    })));
                },
            } });
            expect(bound).toBeNull();
            expect(controls.getSnapshot()).toMatchObject([{ id: 'run', busy: false }]);
            press = controls.press('run');
            expect(await Promise.race([
                projectionRequested.promise.then(() => 'awaiting-Machine'),
                press.then(async () => ({ earlySettlement: await settlement })),
            ])).toBe('awaiting-Machine');
            expect(homes.requestsFor('/v1/actions/action.invoke')).toHaveLength(0);
            held.resolve();
            await press;
            expect(await settlement).toMatchObject({ ok: true, result: { rows: ['current'] } });
            expect(homes.requestsFor('/v1/actions/action.invoke')).toHaveLength(1);
        } finally { held.resolve(); await press; controller.dispose(); unregister(); withdraw(); }
    });
});

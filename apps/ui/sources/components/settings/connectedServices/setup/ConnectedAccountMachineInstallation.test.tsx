import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionOperationSnapshotV1Schema, type ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';
import type { PluginConnectedAccountMachineSetupV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { coder } from '../../../../../../../packages/plugins/machine-recipes/src/coder';

// test-policy-boundary: Metro's lazy module loader is substituted; the actual Action executor stays real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const nativeRpc = vi.hoisted(() => ({
    readOperation: null as (() => Promise<ActionOperationGetV1Response>) | null,
}));
// test-policy-boundary: the native Machine RPC transport answers its real operation-get wire contract.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    return createServerScopedMachineRpcBoundaryMock(async request => {
        if (request.method !== ACTION_OPERATION_RPC_METHODS_V2.get || !nativeRpc.readOperation) {
            throw new Error(`Unexpected native RPC: ${request.method}`);
        }
        expect(request.machineId).toBe('coder-machine');
        expect(request.payload).toMatchObject({ operationId: 'coder-setup', waitForTerminal: true });
        return nativeRpc.readOperation();
    });
});

installApprovalCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ renderCustomModals: true }).module;
    },
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
await loadSyncSingletonForTests();

const declaration = {
    title: 'Install Coder on a Machine',
    recipe: { pluginId: 'happier.machine.recipes', recipeId: 'coder', revision: '1' },
    afterApply: { modeId: 'first-admin', configurationFromInputs: { endpoint: 'accessUrl' } },
} satisfies PluginConnectedAccountMachineSetupV1;
const recipe = {
    id: `${declaration.recipe.pluginId}/${declaration.recipe.recipeId}`,
    pluginId: declaration.recipe.pluginId,
    pluginVersion: '1',
    definition: MachineRecipeV1Schema.parse({ ...coder, id: declaration.recipe.recipeId }),
};

beforeEach(async () => {
    await homes.reset();
    actionOperationStore.reset();
    resetScopedHomeActionExecutorsForTests();
    nativeRpc.readOperation = null;
});
afterEach(async () => {
    standardCleanup();
    actionOperationStore.reset();
    await homes.reset();
});

it('waits for Account recipe declarations before enabling installation Review', async () => {
    const { ConnectedAccountMachineInstallation } = await import('./ConnectedAccountMachineInstallation');
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const home = await homes.addHome({ name: 'Cold recipe declarations', serverUrl: 'https://coder-setup-declarations.test',
        serverIdentityId: 'srv_coder_setup_declarations', accountId: 'owner', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    const machineId = 'coder-machine';
    const scope = { serverId, accountId: 'owner' };
    const { storage } = await import('@/sync/domains/state/storage');
    await act(async () => {
        storage.setState({ settingsScope: scope });
        await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({ id: machineId,
            accountId: 'owner', machine: { activeAt: Date.now() } })]);
    });
    homes.answer(home, '/v1/actions/machines.setup.plan', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.setup.plan',
            requestId: envelope.requestId, execution: { ok: true, result: MachineSetupPlanResultV1Schema.parse({
                desiredRevision: 0, sources: [], exclusions: [], support: [],
            }) } }) };
    } });
    const screen = await renderScreen(<ConnectedAccountMachineInstallation declaration={declaration}
        serverId={serverId} machineId={machineId} machineName="Coder host" online={true}
        localize={text => typeof text === 'string' ? text : 'Install Coder on a Machine'} onReady={vi.fn()} />);
    try {
        expect(screen.findByTestId('connected-account-machine-setup:review')?.props.disabled).toBe(true);
        await act(async () => replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } }));
        await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard)
            .some(card => card.props.kind === 'unavailable' && card.props.diagnosticCode === undefined)).toBe(true));
        expect(screen.findByTestId('connected-account-machine-setup:review')?.props.disabled).toBe(true);
    } finally { await screen.unmount(); }
});

it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'hands off the reviewed endpoint only after Machine setup %s',
    async terminalState => {
        const { ConnectedAccountMachineInstallation } = await import('./ConnectedAccountMachineInstallation');
        const homeId = `srv_coder_setup_${terminalState}`;
        const home = await homes.addHome({ name: 'Coder setup', serverUrl: `https://coder-setup-${terminalState}.test`,
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const machineId = 'coder-machine';
        const scope = { serverId, accountId: 'owner' };
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            storage.setState({ settingsScope: scope });
            await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({ id: machineId,
                accountId: 'owner', machine: { activeAt: Date.now() } })]);
        });
        homes.answer(home, '/v1/actions/machines.setup.plan', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
            const result = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0,
                sources: request.sources ?? [{ kind: 'direct', setup: {} }], exclusions: [], support: [],
                ...(request.mode === 'effects' ? { recipePlans: [] } : {}),
            });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.setup.plan',
                requestId: envelope.requestId, execution: { ok: true, result } }) };
        } });
        const applied: unknown[] = [];
        const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
            // Only the installed host's native setup port is substituted; both Action executors run.
            machineSetupApply: async ({ input }) => {
                applied.push(input);
                return { operationId: 'coder-setup' };
            },
        }));
        const boundary = await answerExternalActionAccountForHome(homes, serverId, {
            machineId, actionId: 'machines.setup.apply', tokenEpoch: 0, requesterInvocation: 'optional',
            failure: result => {
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : null;
            },
            execute: async (input, transport) => {
                const authorization = transport.authorization;
                if (!authorization) throw new Error('Apply must use the signed Home admission');
                const result = await receiver.execute('machines.setup.apply', input, {
                    surface: transport.invocation?.surface ?? 'ui', authority: transport.invocation?.authority ?? 'present_user',
                    actionCaller: transport.invocation?.caller ?? { kind: 'host' },
                    serverId, serverIdentityId: homeId, runtimeAccountId: 'owner', actionRequestId: transport.requestId,
                    externalActionTarget: transport.target, presentUserConfirmation: transport.invocation?.presentUserConfirmation,
                    externalActionExecutionAuthorization: authorization, originalActionEnvelope: transport.envelope,
                    signExternalActionApprovalInput: ({ actionId, input: reviewedInput, target, requesterConfirmation, sessionTargetsV1 }) =>
                        boundary.signApprovalInput({ authorizationToken: authorization.token, actionId, input: reviewedInput, target,
                            ...(requesterConfirmation ? { requesterConfirmation } : {}),
                            ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
                });
                return result.ok ? result.result : result;
            },
        });
        const terminalRead = createDeferred<ActionOperationGetV1Response>();
        nativeRpc.readOperation = () => terminalRead.promise;
        const onReady = vi.fn();
        const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, machineRecipesById: { [recipe.id]: recipe } },
            pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId, serverId,
            platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        }}><ConnectedAccountMachineInstallation declaration={declaration}
            serverId={serverId} machineId={machineId} machineName="Coder host" online={true}
            localize={text => typeof text === 'string' ? text : 'Install Coder on a Machine'} onReady={onReady} onCancel={vi.fn()} />
        </AppShellPluginUiProjectionValueProvider>);
        await act(async () => {
            screen.changeTextByTestId('connected-account-machine-setup:inputs.0.accessUrl', 'https://coder.example.com');
        });
        await screen.pressByTestIdAsync('connected-account-machine-setup:review');
        await vi.waitFor(() => expect(screen.findByTestId('connected-account-machine-setup:apply')).toBeTruthy());
        expect(onReady).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('connected-account-machine-setup:apply');
        await vi.waitFor(() => expect(applied).toHaveLength(1));
        const reviewed = MachineSetupApplyInputV1Schema.parse(applied[0]);
        expect(reviewed.targets[0]?.sources).toEqual([{ kind: 'direct', setup: { items: [{ kind: 'setupRecipe',
            selection: { ref: declaration.recipe, inputs: { accessUrl: 'https://coder.example.com' } },
        }] } }]);
        expect(onReady).not.toHaveBeenCalled();

        const operation = { version: 1, operationId: 'coder-setup', actionId: 'machines.setup.apply',
            scope: { accountId: 'owner', machineId }, title: 'Install Coder', createdAt: 1, startedAt: 2,
            cancellation: 'supported' };
        await act(async () => publishActionOperationObservation({ serverId, machineId, observation: 'available', snapshots: [
            ActionOperationSnapshotV1Schema.parse({ ...operation, revision: 2, state: 'running' }),
        ] }));
        expect(onReady).not.toHaveBeenCalled();
        await act(async () => {
            terminalRead.resolve({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({
                ...operation, revision: 3, state: terminalState, settledAt: 3,
                ...(terminalState === 'succeeded' ? { result: { operationId: 'coder-setup' } } : {}),
                ...(terminalState === 'failed' ? { error: { errorCode: 'setup_failed', error: 'Installation failed' } } : {}),
            }) });
        });
        if (terminalState === 'succeeded') {
            await vi.waitFor(() => expect(onReady).toHaveBeenCalledExactlyOnceWith({ endpoint: 'https://coder.example.com' }));
        } else {
            await vi.waitFor(() => expect([...actionOperationStore.getSnapshot().operationsByKey.values()]
                .find(item => item.snapshot.operationId === 'coder-setup')?.snapshot.state).toBe(terminalState));
            await act(async () => {});
            expect(onReady).not.toHaveBeenCalled();
        }
        await screen.unmount();
    },
);

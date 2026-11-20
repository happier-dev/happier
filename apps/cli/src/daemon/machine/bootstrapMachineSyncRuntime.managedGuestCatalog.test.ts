import { expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt } from './bootstrapMachineSyncRuntime';

it.each([
    { label: 'plain Lima process enrollment', opaque: false, nativeProcess: false, sameCustodian: true, usesController: true },
    { label: 'opaque Coder native process enrollment', opaque: true, nativeProcess: true, sameCustodian: true, usesController: true },
    { label: 'opaque enrollment without process placement', opaque: true, nativeProcess: false, sameCustodian: true, usesController: false },
    { label: 'opaque native process enrollment with a foreign custodian', opaque: true, nativeProcess: true, sameCustodian: false, usesController: false },
])('resolves the Home-enrolled Connected Account catalog for $label', async ({ opaque, nativeProcess, sameCustodian, usesController }) => {
    const machineId = 'guest';
    const controllerMachineId = 'controller';
    const homeId = 'home';
    const accountId = 'owner';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
    const target = { kind: 'account' as const, account: {
        service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'muse-source',
    } };
    const provider = { pluginId: 'happier.machine.lima', localId: 'lima' };
    const managed = ManagedMachineV1Schema.parse({
        id: 'managed-guest', homeId, custodianAccountId: sameCustodian ? accountId : 'other-account', enrollmentAccountId: accountId,
        enrolledMachineId: machineId, controller: { machineId: controllerMachineId, installationId: 'controller-installation' },
        ...(opaque ? { preset: { id: 'coder-preset', revision: 0, contentEncryptionMode: 'e2ee' } } : {
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            launch: { provider, name: 'Lima', schemaVersion: 1, choices: {} },
            resource: { contributionRef: provider, schemaVersion: 1, value: {} },
        }),
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now',
        intentRevision: 0, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    });
    const read = opaque ? { machine: managed, presetContent: {
        content: { t: 'encrypted', c: Buffer.alloc(64).toString('base64') }, recipientEnvelope: null,
    } } : managed;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        controller: pluginReloadController, coldStart: true,
        plugins: [{
            manifest: { schemaVersion: 2, id: 'acme.guest-catalog-test', version: '1.0.0', displayName: 'Guest catalog fixture',
                engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' }, contributes: {} },
            files: { 'daemon.mjs': 'export function activate() {}' },
        }],
        resolveContributes: happyHomeDir => resolveMergedContributionRegistry({ happyHomeDir }),
    });
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential mutation'); };
    const purposes = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
        assertTargetAccountMaterializable: unexpected,
        resolveTarget: async requested => requested.kind === 'account' ? { account: requested.account, displayName: 'Muse' } : null,
    });
    const model = { id: 'meta/muse-spark-1.3-contributor', name: 'Muse Spark' };
    const guestObserve = vi.fn(async () => ({ ok: false as const }));
    const controllerObserve = vi.fn(async () => ({ ok: true as const, result: {
        agentId: 'muse', source: 'dynamic', supportsFreeform: false, availableModels: [model],
    } }));
    const origin = 'http://home.test';
    const boot = (id: string, invoke: typeof guestObserve | typeof controllerObserve) => runWithServerHttpBaseUrl(origin, () => bootstrapMachineSyncRuntime({
        cliVersion: 'test', machineId: id, credentials,
        machine: { id, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        preferredHost: 'host.local', happyHomeDir: fixture.happyHomeDir, happyLibDir: fixture.happyHomeDir,
        filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => ({ ...createApiMachineTransportFixture(), connect() {}, registerLiveStreamRelayRoutes() {},
            setRPCHandlers: () => ({ hostCapabilities: { invoke } }),
        }) as unknown as ApiMachineClient,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async () => ({ type: 'success', sessionId: 'unused' }),
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }), stopSession: async () => ({ status: 'stopped' }),
        isSessionAlreadyRunning: async () => false, loadLocalSessionMetadataForHandoff: async () => null,
        beforeShutdown: async () => {}, requestShutdown: () => {}, directPeerServerLifecycle: null,
        directTransferRegistryHost: createCliRegistryHostV1(), connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
        daemonServerWorkScheduler: {} as never,
        getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { providers: { enabled: true } } }) }),
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: id }),
        resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
    }));
    const runtimes: Awaited<ReturnType<typeof boot>>[] = [];
    const app = fastify();
    const managedLookups: { homeId: string; enrolledMachineId: string }[] = [];
    app.post<{ Body: (typeof managedLookups)[number] }>(managedMachineActionEndpointPathV1('machines.managed.list'), async request => {
        expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        managedLookups.push(request.body);
        return { machines: request.body.enrolledMachineId === machineId ? [read] : [] };
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    const rpc = vi.spyOn(machineRpc, 'callExactMachineRpc');
    try {
        const controller = await boot(controllerMachineId, controllerObserve);
        runtimes.push(controller);
        vi.stubEnv('HAPPIER_MANAGED_GUEST_PROCESS', nativeProcess ? '1' : undefined);
        const guest = await boot(machineId, guestObserve);
        runtimes.push(guest);
        vi.unstubAllEnvs();
        const controllerServices = controller.providerOperationsProducer!.machineServices;
        const guestServices = guest.providerOperationsProducer!.machineServices;
        rpc.mockImplementation(async request => {
            expect(request.machineId).toBe(controllerMachineId);
            return controllerServices.projectModels(request.request as Parameters<typeof controllerServices.projectModels>[0], request.signal);
        });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
            loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const request = { machineId, agentTargetKey: 'agent:happier.agent.codex/codex', connectedAccountTarget: target, sourceCatalog: true };
        expect(managedLookups).toEqual([]);
        if (!usesController) {
            await expect(guestServices.projectModels(request)).resolves.toMatchObject({
                status: 'error', error: { code: 'provider_catalog_unavailable' },
            });
            expect(rpc).not.toHaveBeenCalled();
            return;
        }
        await expect(guestServices.projectModels(request)).resolves.toMatchObject({
            status: 'success', groups: expect.arrayContaining([expect.objectContaining({
                catalogObserved: true, rows: expect.arrayContaining([expect.objectContaining({
                    descriptor: expect.objectContaining({ id: 'muse-spark-1.3-contributor' }),
                })]),
            })]),
        });
        expect(guestObserve).not.toHaveBeenCalled();
        expect(managedLookups).toEqual([{ homeId, enrolledMachineId: machineId }, { homeId, enrolledMachineId: controllerMachineId }]);
    } finally {
        vi.unstubAllEnvs();
        await Promise.all(runtimes.map(runtime => retireMachineSyncRuntimeAttempt(runtime)));
        resetActiveAccountSettingsSnapshotForTests();
        rpc.mockRestore();
        restoreHttp();
        await app.close();
        await fixture.dispose();
    }
});

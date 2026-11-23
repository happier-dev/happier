import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { registerMachineAccessLossReceiver } from '@/daemon/externalActions/registerMachineAccessLossReceiver';
import { updateSettings } from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, WorkspaceExecutionConfigReadRequestV1Schema, WorkspaceExecutionConfigReadResponseV1Schema } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';

const boundary = vi.hoisted(() => ({
    control: null as Parameters<typeof startDaemonControlServer>[0] | null,
    database: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null,
}));
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43131, stop: async () => {} };
} }));
vi.mock('../../../server/sources/storage/db', () => ({
    get db() {
        if (!boundary.database) throw new Error('Installed Home resource database is unavailable');
        return boundary.database.db;
    },
    getDbProviderFromEnv: () => 'postgres',
}));
afterEach(() => { boundary.control = null; boundary.database = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('stops a withdrawn person\'s running Service through the existing access-loss cleanup and leaves other Services running', async () => {
    const home = 'srv_machine_service_access_loss';
    let routes: DaemonLocalServicesMachineRpcRoutes | undefined;
    let accessLoss: Parameters<typeof registerMachineAccessLossReceiver>[1] | undefined;
    let settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
    for (const actionId of ['localServices.launcher.start', 'localServices.actions.restartManaged', 'projects.inspect'] as const) {
        settings = setActionApprovalOverride({ settings, actionId, surface: 'rpc', approvalRequired: false });
        settings = setActionApprovalOverride({ settings, actionId, surface: 'api', approvalRequired: false });
    }
    const features = FeaturesResponseSchema.parse({ features: { localServices: { enabled: true,
        inventory: { enabled: true }, managed: { enabled: true }, launcher: { enabled: true }, actions: { enabled: true } },
        browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} });
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
        serverId: home, homeServerIdentityId: home, ordinaryAccountSession: true, externalActionAccountId: 'requester',
        accountSettings: { actionsSettingsV1: settings },
        machineRpcMethods: [getActionSpec('localServices.launcher.start').bindings!.rpcMethod!,
            getActionSpec('localServices.actions.restartManaged').bindings!.rpcMethod!, getActionSpec('projects.inspect').bindings!.rpcMethod!,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT],
        onLocalServicesRoutesReady: observed => { routes = observed; },
        onMachineAccessLossReceiverReady: options => { accessLoss = options; },
        resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features }),
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    });
    if (!routes) throw new Error('Actual daemon did not produce Local Service routes');
    await updateSettings(current => ({ ...current, activeServerId: home, servers: { ...current.servers,
        [home]: { id: home, name: 'Service fixture Home', serverUrl: 'https://session-home.test', webappUrl: 'https://session-home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: home,
                canonicalServerUrl: 'https://session-home.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://session-home.test' }] }) } } }));
    // Actual daemon startup installed these routes on its supplied Machine.
    // Registering them again would create a second Action-method owner.
    const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Machine manager');
    boundary.database = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
        installation: h.f.installation, members: [{ accountId: 'member-use', accessLevel: 'view' }, { accountId: 'member-manage', accessLevel: 'admin' }] });
    const startMethod = getActionSpec('localServices.launcher.start').bindings!.rpcMethod!;
    const restartMethod = getActionSpec('localServices.actions.restartManaged').bindings!.rpcMethod!;
    const inspectMethod = getActionSpec('projects.inspect').bindings!.rpcMethod!;
    const relay = await createInstalledMachineRpcRelay({ manager, machineId: 'machine', transportOwnerAccountId: 'requester',
        ui: { installation: h.f.installation }, methods: [startMethod, restartMethod, inspectMethod, RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT] });
    const nativeLog = join(h.cwd, 'native-service-starts.log');
    const nativeProgram = `require('node:fs').appendFileSync(${JSON.stringify(nativeLog)}, ${JSON.stringify('owner-native-service\n')}); setInterval(() => {}, 1000);`;
    await writeFile(join(h.cwd, '.happier', 'project.json'), JSON.stringify({ version: 1,
        services: { worker: { source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(nativeProgram)}` } } } }));
    const postHome = vi.mocked(axios.post).getMockImplementation();
    if (!postHome) throw new Error('Missing Home HTTP boundary');
    vi.mocked(axios.post).mockImplementation(async (url, raw, options) => {
        const path = new URL(String(url)).pathname;
        if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
            WorkspaceExecutionConfigReadRequestV1Schema.parse(raw);
            return { status: 200, data: WorkspaceExecutionConfigReadResponseV1Schema.parse({ status: 'absent' }) };
        }
        if (path !== bindExternalActionExecutionAuthorizationHttpPathV1('projects.inspect') && path !== '/v1/actions/projects.inspect') {
            return postHome(url, raw, options);
        }
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'synthetic-home-inspection', binding: {
            accountId: 'requester', custodianAccountId: 'requester', serverIdentityId: home,
            authentication: { kind: 'terminal', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            machineId: 'machine', installationId: h.f.installation.installationId,
            actionId: 'projects.inspect', requestId: envelope.requestId, target: envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
        if (path !== '/v1/actions/projects.inspect') return { status: 200, data: authorization };
        // The source inspector enters its own genuine Home CALL. No inner
        // inspection context or admission is manufactured by this HTTP boundary.
        const result = await relay.invokeUi(inspectMethod, createTargetedActionRpcRequestV1(envelope.input, { kind: 'machine', machineId: 'machine' }));
        const failure = result !== null && typeof result === 'object' && 'ok' in result && result.ok === false;
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
            requestId: envelope.requestId, execution: failure ? result : { ok: true, result } }) };
    });
    const source = { serverId: home, workspaceId: 'workspace', machineId: 'machine', rootPath: h.cwd };
    const declaration = { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'worker' } } as const;
    const request = { machineId: 'machine', workspace: source, workspaceId: 'workspace', declaration,
        targetId: createProjectServiceDeclarationTargetIdV1({ id: 'workspace', serverId: home, machineId: 'machine' }, declaration.selection) };
    const target = { kind: 'machine', machineId: 'machine' } as const;
    try {
        const reviewResponse = await relay.invokeUi(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            { machineId: 'machine', workspaceRoot: h.cwd, startReview: { request, surface: 'rpc' } });
        expect(reviewResponse).toMatchObject({ protocolVersion: 1 });
        const reviewed = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(reviewResponse);
        const review = reviewed.startReview;
        if (!review || 'ok' in review) throw new Error(`Owner Service review was refused: ${JSON.stringify(review)}`);
        expect(review).toHaveProperty('reviewedEffectDigest');
        const admittedStart = { ...request, expectedEffectDigest: review.reviewedEffectDigest };
        const started = await relay.invokeUi(startMethod, createTargetedActionRpcRequestV1(admittedStart, target));
        expect(started).toMatchObject({ status: 'succeeded' });
        await expect.poll(async () => readFile(nativeLog, 'utf8')).toBe('owner-native-service\n');
        const services = h.plugin.registry.projectManagedServices;
        const running = services.listProjectServices().find(service => service.kind === 'workspace');
        if (!running || running.kind !== 'workspace') throw new Error('The started Service was not retained');
        expect(running.snapshot()).toMatchObject({ state: 'running' });
        // Start records whose work this is; access loss reads exactly that.
        expect(running.requester.accountId).toBe('requester');
        // The daemon's own access-loss receiver, as published at startup, behind the real Machine
        // RPC authorizer; only Home's installed-Machine currentness answer is substituted.
        if (!accessLoss) throw new Error('Runtime did not publish its access-loss receiver');
        const lossRpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
                resolveCustodianAccountId: async () => 'requester', resolveInstallationId: () => h.f.installation.installationId,
                verifyMachineAdmission: async () => true }) });
        registerMachineAccessLossReceiver(lossRpc, { ...accessLoss, machineId: 'machine' });
        const lose = (subjectAccountId: string) => lossRpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
            params: { v: 1, subjectAccountId }, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
            machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
                installationId: h.f.installation.installationId, role: 'manage', encryptionMode: 'plain' } });
        // Another person's withdrawal leaves this Service alone.
        const unrelated = await lose('member-manage');
        expect(unrelated, JSON.stringify(unrelated)).toMatchObject({ kind: 'settled' });
        expect(running.snapshot().state).toBe('running');
        // The Service's own person's withdrawal ends it (open-ended access ends at withdrawal).
        await lose('requester');
        await expect.poll(() => running.snapshot().state).toBe('stopped');
    } finally {
        await relay.close();
        await h.plugin.registry.projectManagedServices.retireProjectServices();
        await h.machine.shutdown();
    }
});

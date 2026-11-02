import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    ExternalActionResponseEnvelopeV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createLocalServiceActionConfirmationNonceV1, createProjectServiceDeclarationTargetIdV1,
    LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { updateSettings } from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, WorkspaceExecutionConfigReadRequestV1Schema,
    WorkspaceExecutionConfigReadResponseV1Schema } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';

const boundary = vi.hoisted(() => ({
    control: null as Parameters<typeof startDaemonControlServer>[0] | null,
    database: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null,
}));
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));
vi.mock('../../../server/sources/storage/db', () => ({
    get db() {
        if (!boundary.database) throw new Error('Installed Home resource database is unavailable');
        return boundary.database.db;
    },
    getDbProviderFromEnv: () => 'postgres',
}));
afterEach(() => { boundary.control = null; boundary.database = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('starts and restarts a native owner Service through Home admission and real daemon routes without member effects', async () => {
    const home = 'srv_machine_service_owner';
    let routes: DaemonLocalServicesMachineRpcRoutes | undefined;
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
        const original = services.listProjectServices()[0];
        expect(original?.snapshot()).toMatchObject({ state: 'running' });
        if (!original) throw new Error('Actual native Service owner did not retain its child');
        for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
            const refused = await relay.invokeUi(startMethod, createTargetedActionRpcRequestV1(admittedStart, target), { actorAccountId });
            expect(refused).toHaveProperty('errorCode');
            expect(refused).not.toMatchObject({ status: 'succeeded' });
        }
        expect(await readFile(nativeLog, 'utf8')).toBe('owner-native-service\n');
        expect(original.snapshot().state).toBe('running');
        const restart = { requestId: 'owner-native-restart', action: 'restart_managed' as const, force: false,
            expectedEffectDigest: review.reviewedEffectDigest, target: { kind: 'managed_service' as const,
                machineId: 'machine', managedServiceId: original.instanceId, workspaceId: 'workspace', declaration, cwd: h.cwd } };
        const restartRequest = { ...restart, confirmationNonce: createLocalServiceActionConfirmationNonceV1(restart) };
        for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
            const refused = await relay.invokeUi(restartMethod, createTargetedActionRpcRequestV1(restartRequest, target), { actorAccountId });
            expect(refused).toHaveProperty('errorCode');
        }
        expect(original.snapshot().state).toBe('running');
        expect(await readFile(nativeLog, 'utf8')).toBe('owner-native-service\n');
        const restarted = LocalServiceActionResultV1Schema.parse(await relay.invokeUi(restartMethod,
            createTargetedActionRpcRequestV1(restartRequest, target)));
        expect(restarted).toMatchObject({ status: 'succeeded' });
        expect(original.snapshot().state).toBe('stopped');
        expect(services.listProjectServices()[0]?.instanceId).not.toBe(original.instanceId);
        await expect.poll(async () => readFile(nativeLog, 'utf8')).toBe('owner-native-service\nowner-native-service\n');
    } finally {
        await relay.close();
        await h.plugin.registry.projectManagedServices.retireProjectServices();
        await h.machine.shutdown();
    }
});

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';

import { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createDaemonMachineRpcRouteAttachmentCache } from '@/daemon/machineRpcRouteAttachments';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createDaemonMachineAdminAccessRoutes } from '@/machines/adminAccess/createDaemonMachineAdminAccessRoutes';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';

import { createUnavailableActionTransportDeps } from './actionTransportDeps';

/** Declared family coverage; absent methods outside this scope remain unverified. */
export const SETUP_RPC_REGISTRATION_ACTION_IDS = Object.freeze([
    ...ACTION_ID_FAMILIES_V1.project_execution,
    ...ACTION_ID_FAMILIES_V1.project_definitions,
    ...ACTION_ID_FAMILIES_V1.managed_machines,
    ...ACTION_ID_FAMILIES_V1.machine_agent_sign_in,
    ...ACTION_ID_FAMILIES_V1.machine_admin_access,
    ...ACTION_ID_FAMILIES_V1.local_services_inventory,
    ...ACTION_ID_FAMILIES_V1.local_services_launcher,
    ...ACTION_ID_FAMILIES_V1.local_services_preview,
    ...ACTION_ID_FAMILIES_V1.local_services_actions,
    ...ACTION_ID_FAMILIES_V1.scm_repository,
]);

/** Actual client registration root and daemon attachments; no expected Action rows are supplied. */
export async function withSetupRpcRegistrations<T>(
    inspect: (registrar: Pick<RpcHandlerManager, 'hasHandler'>) => T | Promise<T>,
): Promise<T> {
    const executor = createActionExecutor(createUnavailableActionTransportDeps());
    const admissionDrain = createDaemonAdmissionDrain();
    const finiteRuntime = createInstalledProjectFiniteRuntime({
        // Home reads and cross-Machine preparation are external transport boundaries.
        api: { getMachine: async () => null }, credentials: { token: 'token', encryption: null },
        externalActionAccountId: 'account', finiteServerId: 'home', finiteServerHttpBaseUrl: 'https://home.test',
        registeredMachineId: 'setup-census',
        admission: createProjectWorkerAdmission({ machineId: 'setup-census', admissionDrain,
            readPolicy: async () => ({ status: 'unavailable' }) }),
        nativeIo: createProjectNativeIo(), successHomeDir: process.cwd(),
        isCurrent: async () => !admissionDrain.isFinalShutdown(),
        prepareBetween: async () => { throw new Error('Unexpected cross-Machine preparation in registration census'); },
        resolveCurrentMachineExecutionOriginContext: async () => null,
    });
    const client = new ApiMachineClient('token', {
        id: 'setup-census', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0,
    }, undefined, { createProjectFiniteRuntime: finiteRuntime });
    const localServices = createLocalServicesDaemonRuntime({ machineId: 'setup-census', startLoop: false });
    // As in the administrator desired-policy fixture, native OS IO is the boundary;
    // registration must not inspect the host or perform an elevated effect.
    const unavailableNativeIo = async (): Promise<never> => { throw new Error('Unexpected native administrator IO in registration census'); };
    const adminAccess = createDaemonMachineAdminAccessRoutes({
        target: () => ({ serverId: 'home', machineId: 'setup-census', installationId: 'installation', custodianAccountId: 'account' }),
        getMachineClient: () => client,
        nativeDependencies: { platform: 'linux', execFile: unavailableNativeIo,
            fileSystem: { lstat: unavailableNativeIo, readFile: unavailableNativeIo } },
        spawnElevation: () => { throw new Error('Unexpected elevation in registration census'); },
    });
    try {
        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unused process boundary' }),
            stopSession: async () => true,
            requestShutdown() {},
        }, { externalActionIngressOwner: {
            currentServerId: 'home', executor, resolveTarget: async () => null,
        } });
        const attachments = createDaemonMachineRpcRouteAttachmentCache({
            getApiMachineForSessions: () => null,
        });
        attachments.attachMachineAdminAccessRoutes(adminAccess);
        attachments.attachLocalServicesRoutes({
            machineId: 'setup-census', serverId: 'home',
            localServicesInventory: localServices.inventoryRoutes,
            localServicesLauncher: localServices.launcherRoutes,
            localServicesPreview: localServices.previewRoutes,
            localServicesActions: localServices.actionRoutes,
            resolveLauncherActionExecutor: () => executor,
        });
        attachments.prepareApiMachineForSessions(client);
        attachments.attachApiMachineForSessions(client);
        // The existing runtime-catalog fixtures inspect this private receiver; no test API
        // or duplicate handler registry is added to the production client.
        const manager = (client as unknown as Readonly<{
            rpcHandlerManager: Pick<RpcHandlerManager, 'hasHandler'>;
        }>).rpcHandlerManager;
        return await inspect(manager);
    } finally {
        try { await client.shutdown(); } finally { await localServices.stop(); }
    }
}

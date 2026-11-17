import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { registerProjectFiniteRpcHandlers } from '@/rpc/handlers/projects/registerProjectFiniteRpcHandlers';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';

import { createUnavailableActionTransportDeps } from './actionTransportDeps';

/** Declared family coverage; absent methods outside this scope remain unverified. */
export const SETUP_RPC_REGISTRATION_ACTION_IDS = Object.freeze([
    ...ACTION_ID_FAMILIES_V1.project_execution,
    ...ACTION_ID_FAMILIES_V1.project_definitions,
    ...ACTION_ID_FAMILIES_V1.managed_machines,
    ...ACTION_ID_FAMILIES_V1.machine_agent_sign_in,
    ...ACTION_ID_FAMILIES_V1.local_services_inventory,
    ...ACTION_ID_FAMILIES_V1.local_services_launcher,
    ...ACTION_ID_FAMILIES_V1.local_services_preview,
    ...ACTION_ID_FAMILIES_V1.local_services_actions,
    ...ACTION_ID_FAMILIES_V1.scm_repository,
]);

/** Real registrar selections for the setup corridor; no expected Action rows are supplied. */
export async function withSetupRpcRegistrations<T>(
    inspect: (registrar: Pick<RpcHandlerManager, 'hasHandler'>) => T | Promise<T>,
): Promise<T> {
    const executor = createActionExecutor(createUnavailableActionTransportDeps());
    const manager = new RpcHandlerManager({ scopePrefix: 'setup-census', encryptionMode: 'plain' });
    const localServices = createLocalServicesDaemonRuntime({ machineId: 'setup-census', startLoop: false });
    const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager,
        handlers: {
            spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unused process boundary' }),
            stopSession: async () => true,
            requestShutdown() {},
        },
        deps: { currentMachineId: 'setup-census', currentServerId: 'home',
            externalAction: { machineId: 'setup-census', currentServerId: 'home',
                resolveAccountId: async () => 'account', resolveInstallationId: () => 'installation',
                verifyExecutionAuthorization: async () => false, resolveTarget: async () => null, executor },
        },
    });
    try {
        registerProjectDefinitionHandlers({ rpcHandlerManager: manager, machineId: 'setup-census', actionExecutor: executor });
        registerProjectFiniteRpcHandlers(manager, { machineId: 'setup-census', serverId: 'home' });
        registerScmHandlers(manager, process.cwd(), { machineId: 'setup-census' });
        registerDaemonLocalServicesMachineRpcHandlers(manager, {
            machineId: 'setup-census', serverId: 'home',
            localServicesInventory: localServices.inventoryRoutes,
            localServicesLauncher: localServices.launcherRoutes,
            localServicesPreview: localServices.previewRoutes,
            localServicesActions: localServices.actionRoutes,
            resolveLauncherActionExecutor: () => executor,
        });
        return await inspect(manager);
    } finally {
        await registration.dispose();
        await localServices.stop();
    }
}

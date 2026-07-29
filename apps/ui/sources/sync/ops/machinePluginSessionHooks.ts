import { getActionSpec } from '@happier-dev/protocol/actions';
import type {
    PluginSessionHookInstallInputV1,
    PluginSessionHookInstallResponseV1,
    PluginSessionHookInstallationMutationInputV1,
    PluginSessionHookStatusInputV1,
    PluginSessionHookStatusResponseV1,
    PluginSessionHookToggleResponseV1,
    PluginSessionHookUninstallResponseV1,
} from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type PluginSessionHookActionId =
    | 'plugins.sessionHooks.status.get'
    | 'plugins.sessionHooks.install'
    | 'plugins.sessionHooks.disable'
    | 'plugins.sessionHooks.enable'
    | 'plugins.sessionHooks.uninstall';

type MachinePluginSessionHookActionInput<TInput> = Readonly<
    TInput & {
        serverId?: string | null;
    }
>;

function readParsedMachineId(payload: unknown): string {
    if (typeof payload !== 'object' || payload === null) {
        throw new Error('plugin_session_hook_action_payload_invalid');
    }
    const machineId = Reflect.get(payload, 'machineId');
    if (typeof machineId !== 'string' || machineId.length === 0) {
        throw new Error('plugin_session_hook_action_machine_id_invalid');
    }
    return machineId;
}

async function executeMachinePluginSessionHookAction<TInput, TOutput>(
    actionId: PluginSessionHookActionId,
    input: MachinePluginSessionHookActionInput<TInput>,
): Promise<TOutput> {
    const spec = getActionSpec(actionId);
    const method = spec.bindings?.rpcMethod;
    if (!method || !spec.outputSchema) {
        throw new Error(`plugin_session_hook_action_spec_incomplete:${actionId}`);
    }
    const { serverId, ...rawPayload } = input;
    const payload = spec.inputSchema.parse(rawPayload);
    const response = await machineRpcWithServerScope<unknown, typeof payload>({
        machineId: readParsedMachineId(payload),
        serverId,
        method,
        payload,
    });
    return spec.outputSchema.parse(response) as TOutput;
}

export function machinePluginSessionHookStatusGet(
    input: MachinePluginSessionHookActionInput<PluginSessionHookStatusInputV1>,
): Promise<PluginSessionHookStatusResponseV1> {
    return executeMachinePluginSessionHookAction('plugins.sessionHooks.status.get', input);
}

export function machinePluginSessionHookInstall(
    input: MachinePluginSessionHookActionInput<PluginSessionHookInstallInputV1>,
): Promise<PluginSessionHookInstallResponseV1> {
    return executeMachinePluginSessionHookAction('plugins.sessionHooks.install', input);
}

export function machinePluginSessionHookDisable(
    input: MachinePluginSessionHookActionInput<PluginSessionHookInstallationMutationInputV1>,
): Promise<PluginSessionHookToggleResponseV1> {
    return executeMachinePluginSessionHookAction('plugins.sessionHooks.disable', input);
}

export function machinePluginSessionHookEnable(
    input: MachinePluginSessionHookActionInput<PluginSessionHookInstallationMutationInputV1>,
): Promise<PluginSessionHookToggleResponseV1> {
    return executeMachinePluginSessionHookAction('plugins.sessionHooks.enable', input);
}

export function machinePluginSessionHookUninstall(
    input: MachinePluginSessionHookActionInput<PluginSessionHookInstallationMutationInputV1>,
): Promise<PluginSessionHookUninstallResponseV1> {
    return executeMachinePluginSessionHookAction('plugins.sessionHooks.uninstall', input);
}

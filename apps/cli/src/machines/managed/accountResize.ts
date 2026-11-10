import { createManagedNativeObservationWait, executeManagedMachineResize, ManagedMachineControllerError,
    type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { ManagedAdmissionOutputV1Schema, ManagedControlAdmissionInputV1Schema, ManagedControllerMachineOutputV1Schema,
    ManagedResizeOutputV1Schema, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { createCliManagedAccountNativeInvocation } from './accountNative';
import type { executeCliManagedAccountPower } from './accountPower';

/** The admitted declaration and exact approved size survive until native settlement. */
export async function executeCliManagedAccountResize(input: Omit<Parameters<typeof executeCliManagedAccountPower>[0], 'body'> & Readonly<{
    body: ManagedMachineActionInputV1<typeof MANAGED_RESIZE_ACTION_ID_V1>;
}>) {
    const requestId = input.context.actionRequestId;
    if (!requestId) throw new ManagedMachineControllerError('admission_unavailable');
    const admitted = await input.post('admit-control', ManagedControlAdmissionInputV1Schema.parse({
        action: MANAGED_RESIZE_ACTION_ID_V1, input: input.body, requestId }), ManagedAdmissionOutputV1Schema);
    const machine = admitted.machine;
    if (machine.controller) throw new ManagedMachineControllerError('controller_unavailable');
    const provisioner = admitted.resizeProvisioner;
    if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
    let native: ManagedNativeInvocation | undefined;
    const invoke: ManagedNativeInvocation = async (role, body, io) => {
        if (!native) {
            const selected = await readCurrentAccountPluginExecutionSelection({ pluginId: machine.launch.provider.pluginId,
                credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
            if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
            native = createCliManagedAccountNativeInvocation({ machine, provisioner, selected, context: input.context,
                signal: input.signal, requestId });
        }
        return native(role, body, io);
    };
    const resize = await executeManagedMachineResize({ machine, provisioner, size: input.body.size, invoke,
        io: { signal: input.signal }, guestStartup: { transport: provisioner.bootstrapTransport,
            channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label },
        waitForObservation: createManagedNativeObservationWait(input.signal) });
    await input.post('report-resize', { homeId: machine.homeId, managedId: machine.id, requestId, ...resize }, ManagedControllerMachineOutputV1Schema, null);
    return ManagedResizeOutputV1Schema.parse(resize);
}

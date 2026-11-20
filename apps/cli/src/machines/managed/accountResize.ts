import { createManagedNativeObservationWait, settleManagedMachineResize, ManagedMachineControllerError,
    type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { ManagedAdmissionOutputV1Schema, ManagedControlAdmissionInputV1Schema, ManagedControllerMachineOutputV1Schema,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { createCliManagedAccountNativeInvocation, resolveCliManagedAccountProvisioner } from './accountNative';
import type { executeCliManagedAccountPower } from './accountPower';
import { createManagedPresetHydrator, openManagedPresetCarrier } from './presetHydration';
import { logger } from '@/ui/logger';

/** The admitted declaration and exact approved size survive until native settlement. */
export async function executeCliManagedAccountResize(input: Omit<Parameters<typeof executeCliManagedAccountPower>[0], 'body'> & Readonly<{
    body: ManagedMachineActionInputV1<typeof MANAGED_RESIZE_ACTION_ID_V1>;
}>) {
    const requestId = input.context.actionRequestId;
    if (!requestId) throw new ManagedMachineControllerError('admission_unavailable');
    const hydrator = createManagedPresetHydrator(input);
    const admitted = await openManagedPresetCarrier(await input.post('admit-control', ManagedControlAdmissionInputV1Schema.parse({
        action: MANAGED_RESIZE_ACTION_ID_V1, input: input.body, requestId }), ManagedAdmissionOutputV1Schema), hydrator, input.signal);
    const machine = admitted.machine;
    if (machine.controller) throw new ManagedMachineControllerError('controller_unavailable');
    const selected = await readCurrentAccountPluginExecutionSelection({ pluginId: machine.launch.provider.pluginId,
        credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
    if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
    const provisioner = resolveCliManagedAccountProvisioner(machine, selected);
    const size = hydrator.isOpaque(machine)
        ? await hydrator.prepareResize(machine, 'presetContentOverride' in input.body ? input.body.presetContentOverride : undefined, input.signal)
        : 'size' in input.body ? input.body.size
            : (() => { throw new ManagedMachineControllerError('credential_unavailable'); })();
    let native: ManagedNativeInvocation | undefined;
    const invoke: ManagedNativeInvocation = async (role, body, io) => {
        if (!native) {
            native = createCliManagedAccountNativeInvocation({ machine, provisioner, selected, context: input.context,
                signal: input.signal, requestId });
        }
        return native(role, body, io);
    };
    return await settleManagedMachineResize({ machine, provisioner, size, invoke, requestId,
        io: { signal: input.signal }, guestStartup: { transport: provisioner.bootstrapTransport,
            channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label },
        waitForObservation: createManagedNativeObservationWait(input.signal),
        onReportFailure: reportError => logger.warn('[MANAGED MACHINE] Native outcome report failed',
            projectActionFailureCauseV1(reportError, MANAGED_RESIZE_ACTION_ID_V1)),
        report: async body => {
            const { report, output } = await hydrator.prepareResizeReport(body, input.signal);
            await input.post('report-resize', report, ManagedControllerMachineOutputV1Schema, null);
            return output;
        },
    });
}

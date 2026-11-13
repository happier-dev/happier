import { inspectManagedMachine, ManagedMachineControllerError,
    type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { ManagedControllerContextOutputV1Schema, ManagedControllerMachineOutputV1Schema }
    from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { StoredCredentials } from '@/persistence';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { createCliManagedAccountNativeInvocation } from './accountNative';
import { publishSettledManagedNativeOperation } from './managedIntentReconciler';

/** Foreground Check now observes Home's retained correlation through the shared recipe. */
export async function executeCliManagedAccountInspect(input: Readonly<{
    machine: ManagedMachineV1;
    context: ActionExecutorContext;
    credentials: StoredCredentials;
    serverUrl: string;
    signal?: AbortSignal;
    post<T>(path: string, body: unknown, schema: Readonly<{ parse(value: unknown): T }>, signal?: AbortSignal | null): Promise<T>;
}>) {
    const retained = await input.post('context', { homeId: input.machine.homeId, managedId: input.machine.id,
        expectedIntentRevision: input.machine.intentRevision }, ManagedControllerContextOutputV1Schema);
    const machine = retained.machine;
    const provisioner = machine.reviewedFacts?.provisioner;
    let native: ManagedNativeInvocation | undefined;
    const observed = await inspectManagedMachine({ machine, requestId: retained.requestId,
        provisioner, signal: input.signal,
        home: {
            correlation: row => ({ homeId: row.homeId, managedId: row.id, expectedIntentRevision: row.intentRevision,
                requestId: retained.requestId, ...(row.controller ? { controller: row.controller } : {}) }),
            row: async (path, body, signal = input.signal) =>
                (await input.post(path, body, ManagedControllerMachineOutputV1Schema, signal)).machine,
        },
        invoke: async (role, body, io) => {
            if (!native) {
                if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
                const selected = await readCurrentAccountPluginExecutionSelection({ pluginId: machine.launch.provider.pluginId,
                    credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
                if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
                native = createCliManagedAccountNativeInvocation({ ...input, machine, provisioner, selected, requestId: retained.requestId });
            }
            return await native(role, body, io);
        },
    });
    if (machine.submittedNativeEffect) publishSettledManagedNativeOperation(input.context, machine, observed, machine.submittedNativeEffect);
    return { machine: observed };
}

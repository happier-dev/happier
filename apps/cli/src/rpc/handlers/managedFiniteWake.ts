import { ManagedFiniteWakeRequestV1Schema, MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { isSocketRpcActionApiServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';

/** Home-authenticated causal preparation consumes the existing installed native policy owner. */
export function registerManagedFiniteWake(rpc: RpcHandlerRegistrar, input: Readonly<{
    readCurrent(managedId: string, signal: AbortSignal): Promise<ManagedMachineV1 | null>;
    executePolicy: ReturnType<typeof createDaemonManagedMachineActionAdapter>['executePolicy'];
}>) {
    rpc.registerHandler(MANAGED_FINITE_WAKE_RPC_METHOD, async (raw: unknown, context) => {
        const refused = { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        if (!context || !isSocketRpcActionApiServerOriginAuthorizationContext(context.authorization)) return refused;
        const request = ManagedFiniteWakeRequestV1Schema.safeParse(raw);
        if (!request.success || context.signal.aborted) return refused;
        const { target, actionOrigin } = request.data;
        const machine = await input.readCurrent(target.managedId, context.signal);
        if (!machine || context.signal.aborted || machine.homeId !== target.homeId
            || machine.enrolledMachineId !== target.enrolledMachineId || machine.intentRevision !== target.expectedIntentRevision
            || machine.controller.machineId !== target.controller.machineId
            || machine.controller.installationId !== target.controller.installationId) return refused;
        return input.executePolicy({ machine, purpose: { kind: 'accepted-input-start', target }, actionOrigin, signal: context.signal });
    });
}

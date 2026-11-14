import { createManagedNativeBootstrapIO, readManagedGuestDiagnostics, ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { createCliManagedAccountNativeInvocation, resolveCliManagedAccountProvisioner } from './accountNative';

/** Installed guest read shares Account role admission and the canonical disclosure owner. */
export async function readCliManagedAccountGuestDiagnostics(input: Readonly<{
    machine: ManagedMachineFullV1; context: ActionExecutorContext; credentials: StoredCredentials;
    serverUrl: string; signal?: AbortSignal;
}>) {
    const provisioner = input.machine.reviewedFacts?.provisioner;
    return readManagedGuestDiagnostics({ machine: input.machine,
        requesterAccountId: input.context.runtimeAccountId ?? readAccountIdFromToken(input.credentials.token) ?? undefined,
        requestId: input.context.actionRequestId ?? undefined,
        transport: input.machine.controller ? undefined : provisioner?.bootstrapTransport,
        channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label,
        signal: input.signal,
        native: { exec: async request => {
            const requestId = input.context.actionRequestId;
            if (!provisioner || !requestId || !input.context.hostReviewedChild) throw new ManagedMachineControllerError('admission_unavailable');
            const selected = await readCurrentAccountPluginExecutionSelection({ pluginId: input.machine.launch.provider.pluginId,
                credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
            if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
            const currentProvisioner = resolveCliManagedAccountProvisioner(input.machine, selected);
            if (!currentProvisioner) throw new ManagedMachineControllerError('provider_unavailable');
            const invoke = createCliManagedAccountNativeInvocation({ ...input, provisioner: currentProvisioner, selected, requestId });
            return createManagedNativeBootstrapIO({ resource: input.machine.resource! }, invoke).exec(request);
        } },
    });
}

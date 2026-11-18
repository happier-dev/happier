import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentReferenceAddressV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import type { NativeDockerEngineFacts } from '@happier-dev/cli-common/machineSetup';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { acquirePrivateServiceContainerBridge } from './privateServiceContainerBridge';
import { acquirePrivateServiceReferenceForwardForHost, resolvePrivateServiceExportAdmissionForHost, type PrivateServiceReferenceHostInput } from './privateServiceReference';
import { privateServiceForwardAcquisitionError } from '../../deploymentFailure';
import { projectDeploymentFailure } from '../../deploymentFailure';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Reconstruct the listeners already embedded in surviving consumer environments.
 * The observation owner's existing release closes these resources. */
export async function restorePrivateServiceReferencesForHost(input: Omit<PrivateServiceReferenceHostInput,
    'source' | 'environment' | 'actionId' | 'readEnvironment'> & Readonly<{
    environmentId: string;
    referenceAddresses: readonly DeploymentReferenceAddressV1[];
    readEnvironment: NonNullable<PrivateServiceReferenceHostInput['readEnvironment']>;
    docker?: ProjectNativeDockerPort;
    engine?: NativeDockerEngineFacts;
    onFailure?(failure: ActionExecuteFailure | null): void;
}>): Promise<Readonly<{ close(): Promise<void> }>> {
    const resources: Readonly<{ close(): Promise<void> }>[] = [];
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
        const failures: unknown[] = [];
        for (const resource of [...resources].reverse()) {
            try { await resource.close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'Private reference cleanup failed');
    })();
    // Docker retains direct source-network membership itself. In particular,
    // split host/port facts are not listener URLs and need no reconstruction.
    const addresses = input.referenceAddresses.filter(address => address.machineId === input.host.machineId
        && address.installationId === input.installationId && address.phase === 'runtime'
        && address.route?.kind === 'iroh');
    if (!addresses.length) return { close };
    const unavailable = (): never => { throw createActionExecuteFailureError({ ok: false, errorCode: 'reference_unavailable', error: 'Retained private service reference is unavailable; retry or redeploy' }); };
    try {
        const environment = await input.readEnvironment({ environmentId: input.environmentId, context: input.context });
        const restored = new Map<string, ActionExecuteFailure | undefined>();
        for (const address of addresses) {
            const route = address.route;
            if (route?.kind !== 'iroh') continue;
            const key = JSON.stringify([address.source, address.address, route.containerNetworkId]);
            if (restored.has(key)) continue;
            restored.set(key, undefined);
            const admission = await resolvePrivateServiceExportAdmissionForHost({ ...input, environment,
                source: address.source, retainedRoute: route.kind, actionId: 'machines.services.list' });
            if (admission.kind !== 'iroh' || !input.host.acquireServiceExportForward) return unavailable();
            const saved = new URL(address.address);
            const port = Number(saved.port);
            if (!port || saved.protocol !== `${admission.scheme}:`) return unavailable();
            const networkId = route.containerNetworkId;
            if (!networkId && saved.hostname !== '127.0.0.1') return unavailable();
            const forward = await acquirePrivateServiceReferenceForwardForHost(admission, remote => input.host.acquireServiceExportForward!({ targetMachineId: remote.machineId,
                serviceExport: remote.serviceExport, context: input.context, signal: input.signal,
                onFailure(error) {
                    const failure = privateServiceForwardAcquisitionError(error);
                    restored.set(key, projectDeploymentFailure(failure.code, failure));
                    input.onFailure?.([...restored.values()].find(Boolean) ?? null);
                },
                onRecovered() {
                    restored.set(key, undefined);
                    input.onFailure?.([...restored.values()].find(Boolean) ?? null);
                },
                ...(!networkId ? { preferredListenPort: port } : {}) })).catch(error => { throw privateServiceForwardAcquisitionError(error); });
            resources.push(forward);
            if (networkId) {
                if (!input.docker || !input.engine) return unavailable();
                const bridge = await acquirePrivateServiceContainerBridge({ docker: input.docker, engine: input.engine,
                    networkId, forward, preferredListenPort: port, signal: input.signal });
                resources.push(bridge);
                if (bridge.host !== saved.hostname) return unavailable();
            }
        }
        return { close };
    } catch (error) { await close(); throw error; }
}

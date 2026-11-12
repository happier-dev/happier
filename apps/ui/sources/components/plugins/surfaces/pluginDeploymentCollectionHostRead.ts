import { createPluginUiResourceStore, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import type { DeploymentActivityV1, DeploymentEnvironmentReadCollectionV1, DeploymentReadLeaseV1 } from '@happier-dev/deployments';
import type { DeploymentControllerAvailabilityV1 } from '@happier-dev/protocol/deployments/deploymentControllerAvailabilityV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readDeploymentProjectOwner } from '@/components/projects/deployments/useDeploymentProject';
import { createMachinePresenceSnapshotSource } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { resolveMachinePresence } from '@/sync/domains/machines/reachability/machinePresence';
import { getStorage } from '@/sync/domains/state/storageStore';

const ACTIVE = Object.freeze({ mounted: true, visible: true, focused: true });
type ReadValue = DeploymentEnvironmentReadCollectionV1 | DeploymentActivityV1;

/** Resource demand borrows the existing deployment controller, including its AccountChange observer. */
export function createPluginDeploymentCollectionHostReadStore(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
}>): PluginUiResourceStore {
    const acquire = (resource: Parameters<PluginUiResourceStore['getEntry']>[0]) => {
        if (typeof resource === 'string' || !('hostRead' in resource) || resource.hostRead !== 'deployments.environments.list') {
            throw Object.assign(new Error('Unsupported deployment host read'), { code: 'unsupported_method', retryable: false });
        }
        const { serverId, projectSourceId, projection, ...query } = resource.input;
        if (serverId !== undefined && !areServerProfileIdentifiersEquivalent(serverId, input.lifetime.scope.serverId)) {
            throw Object.assign(new Error('Deployment Account is unavailable'), { code: 'action_account_scope_changed', retryable: false });
        }
        const owner = readDeploymentProjectOwner(input.lifetime, projectSourceId);
        const releaseDemand = owner.acquireDemand();
        const lease: DeploymentReadLeaseV1<ReadValue> = projection === 'activity'
            ? owner.controller.acquireActivity(ACTIVE)
            : owner.controller.acquireCollection({ ...query, allPages: true }, ACTIVE);
        let disposed = false;
        return { lease, dispose() { if (disposed) return; disposed = true; lease.release(); releaseDemand(); } };
    };
    const presenceSource = (value: ReadValue) => {
        const machineIds = 'items' in value
            ? [...new Set(value.items.map(item => item.environment.controllerMachineId))].sort() : [];
        const readMachines = () => machineIds.map(id => resolveServerScopedMachine(getStorage().getState(), input.lifetime.scope.serverId, id));
        const source = createMachinePresenceSnapshotSource(readMachines, () => readMachines().map((machine, index): DeploymentControllerAvailabilityV1 => {
            const presence = machine ? resolveMachinePresence(machine) : 'unknown';
            return { machineId: machineIds[index]!, state: presence === 'unknown' ? 'unknown' : presence === 'online' ? 'available' : 'paused' };
        }),
        [{ serverId: input.lifetime.scope.serverId, machineIds }], (left, right) => left.length === right.length
            && left.every((fact, index) => fact.machineId === right[index]!.machineId && fact.state === right[index]!.state));
        return { ...source, key: JSON.stringify(machineIds) };
    };
    return createPluginUiResourceStore({ accountLifetime: input.lifetime, client: {
        async readResource(resource, options) {
            const held = acquire(resource);
            let unsubscribe = () => {};
            let abort = () => {};
            try {
                const value = await new Promise<ReadValue>((resolve, reject) => {
                    abort = () => reject(Object.assign(new Error('Deployment read cancelled'), { code: 'cancelled', retryable: false }));
                    const settle = () => {
                        const snapshot = held.lease.getSnapshot();
                        if (snapshot.status === 'ready' && snapshot.value) resolve(snapshot.value);
                        else if (snapshot.status === 'unavailable') reject(Object.assign(new Error(snapshot.failure?.code ?? 'deployment_unavailable'), {
                            code: snapshot.failure?.code ?? 'deployment_unavailable', retryable: snapshot.failure?.retryable ?? false,
                        }));
                    };
                    options?.signal?.addEventListener('abort', abort, { once: true });
                    if (options?.signal?.aborted) { abort(); return; }
                    unsubscribe = held.lease.subscribe(settle);
                    settle();
                });
                // This Resource's bytes include the same owner-produced controller fact
                // read by Forge's env.get. Receipt/history readiness remains independent.
                const projection = 'items' in value ? { ...value, controllerAvailability: presenceSource(value).getSnapshot() } : value;
                const bytes = new TextEncoder().encode(JSON.stringify(projection));
                return { contentType: 'application/json', bytes, digest: computePluginUiArtifactSha256DigestV1(bytes) };
            } finally { options?.signal?.removeEventListener('abort', abort); unsubscribe(); held.dispose(); }
        },
        async watchResource(resource, listener, options) {
            const held = acquire(resource);
            let presenceKey: string | undefined;
            let stopPresence = () => {};
            const observe = () => {
                const snapshot = held.lease.getSnapshot();
                if (snapshot.status === 'ready' && snapshot.value) {
                    const source = presenceSource(snapshot.value);
                    if (source.key !== presenceKey) {
                        stopPresence();
                        presenceKey = source.key;
                        let previous = source.getSnapshot();
                        stopPresence = source.subscribe(() => {
                            const next = source.getSnapshot();
                            if (next === previous) return;
                            previous = next;
                            listener({ kind: 'invalidated' });
                        });
                    }
                }
            };
            const unsubscribe = held.lease.subscribe(() => {
                observe();
                const snapshot = held.lease.getSnapshot();
                if (snapshot.status === 'ready' || snapshot.status === 'unavailable') listener({ kind: 'invalidated' });
            });
            observe();
            const dispose = () => { unsubscribe(); stopPresence(); held.dispose(); options?.signal?.removeEventListener('abort', dispose); };
            options?.signal?.addEventListener('abort', dispose, { once: true });
            if (options?.signal?.aborted) dispose();
            return { dispose };
        },
    } });
}

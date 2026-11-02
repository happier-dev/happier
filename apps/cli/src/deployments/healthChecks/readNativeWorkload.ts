import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/v1';
import { createDeploymentMemberVersionProjectionV1, createDeploymentHealthAggregateLeaseV1,
    type DeploymentHealthServicesObservationV1, type DeploymentHealthObservationV1, type DeploymentHealthAggregateLeaseV1 } from '@happier-dev/deployments';
import type { EnvironmentProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';
import type { createMachineServiceRowProjection } from '@/daemon/local/services/launch/machineServiceRowProjection';

type NativeWorkloadInput = Readonly<{
    environment: DeploymentEnvironmentDetailV1;
    receipts: AsyncIterable<DeploymentReceiptDetailV1>;
    signal: AbortSignal;
    observedAtMs: number;
    edge?: Readonly<{
        read(environmentId: string, targetLinkId: string): DeploymentHealthObservationV1 | null;
        subscribe(listener: () => void): Readonly<{ dispose(): void }>;
    }>;
    local: Readonly<{ machineId: string; installationId: string;
        rows: Pick<ReturnType<typeof createMachineServiceRowProjection>, 'read' | 'subscribe'>;
        resolve(identity: Pick<EnvironmentProjectManagedServiceHandle['identity'], 'machineId' | 'environmentId' | 'composeService'>): EnvironmentProjectManagedServiceHandle | null }>;
}>;

function nativeObservation(row: MachineServiceRowV1,
    observedAtMs: number): NonNullable<DeploymentHealthServicesObservationV1['services'][number]['observation']> {
    const health = row.health;
    return { status: health?.status ?? 'unknown', observedAtMs: health?.observedAtMs ?? observedAtMs,
        ...(health?.expectedDown ? { expectedDown: health.expectedDown } : {}),
        ...(health?.reason ? { reason: health.reason } : health ? {} : { reason: 'coverage_unavailable' }),
    };
}

/** Finite receipt acquisition followed only by existing native owner pushes.
 * Remote/unsupported services retain unknown coverage; handles never decide membership. */
export async function observeNativeWorkload(input: NativeWorkloadInput): Promise<DeploymentHealthAggregateLeaseV1 | null> {
    input.signal.throwIfAborted();
    const environment = input.environment.environment;
    const links = input.environment.targetLinks.map(value => value.targetLink);
    const targetLink = links.find(link => link.id === environment.runtimeTargetLinkId);
    if (!targetLink || targetLink.targetKind !== 'ownServer') return null;
    const projection = createDeploymentMemberVersionProjectionV1(targetLink, links);
    const receipts = new Map<string, DeploymentReceiptDetailV1>();
    for await (const receipt of input.receipts) {
        input.signal.throwIfAborted();
        receipts.set(receipt.deployment.id, receipt);
        if (projection.addReceipt(receipt)) break;
    }
    const versions = projection.getVersions();
    const retained: Array<Readonly<{ handle: EnvironmentProjectManagedServiceHandle; memberIndex: number; serviceIndex: number }>> = [];
    let observations = targetLink.members.filter(member => member.state === 'active').map((member, memberIndex): DeploymentHealthServicesObservationV1 => {
        const scope = { environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
            machineId: member.machineId, installationId: member.installationId, role: 'runtime' as const,
            source: { kind: 'native' as const }, observedAtMs: input.observedAtMs };
        const version = versions[member.machineId];
        const receipt = version && !version.uncertain && version.deploymentId !== null ? receipts.get(version.deploymentId) : undefined;
        const basis = receipt?.content.ownServer?.approvedInputBasis;
        const exact = basis?.runtimeProjections?.find(value => value.machineId === member.machineId && value.installationId === member.installationId);
        const services = exact?.services ?? (basis?.runtimeProjections === undefined && basis?.members.length === 1
            && basis.members[0]?.machineId === member.machineId && basis.members[0].installationId === member.installationId ? basis.services : []);
        return { ...scope, services: services.map((composeService, serviceIndex) => {
            input.signal.throwIfAborted();
            const serviceId = `${environment.id}/${composeService}`;
            if (!receipt || member.machineId !== input.local.machineId || member.installationId !== input.local.installationId) return { serviceId };
            const handle = input.local.resolve({ machineId: member.machineId, environmentId: environment.id, composeService });
            if (!handle || handle.deploymentId !== receipt.deployment.id || handle.machineId !== member.machineId
                || handle.release.installationId !== member.installationId || !handle.isCurrent() || handle.retirementSignal.aborted) return { serviceId };
            retained.push({ handle, memberIndex, serviceIndex });
            return { serviceId, observation: nativeObservation(input.local.rows.read(handle), input.observedAtMs) };
        }) };
    });
    const retirementSignal = AbortSignal.any([input.signal, ...retained.map(({ handle }) => handle.retirementSignal)]);
    const currentObservations = () => {
        const edge = input.edge?.read(environment.id, targetLink.id);
        return edge ? [...observations, edge] : observations;
    };
    const health = createDeploymentHealthAggregateLeaseV1({ initial: { environment, targetLink, observations: currentObservations() },
        isCurrent: () => retained.every(({ handle }) => handle.isCurrent()), retirementSignal });
    const subscription = input.local.rows.subscribe(input.local.machineId, retained.map(value => value.handle), change => {
        if (!health.isCurrent()) return;
        const selected = retained.find(value => value.handle === change.handle);
        if (!selected) return;
        const row = change.row;
        if (!row) { health.dispose(); return; }
        const { memberIndex, serviceIndex } = selected;
        observations = observations.map((member, index) => index !== memberIndex ? member : { ...member,
            services: member.services.map((service, index) => index !== serviceIndex ? service : {
                ...service, observation: nativeObservation(row, input.observedAtMs),
            }),
        });
        health.adopt({ environment, targetLink, observations: currentObservations() });
    });
    const edgeSubscription = input.edge?.subscribe(() => {
        if (health.isCurrent()) health.adopt({ environment, targetLink, observations: currentObservations() });
    });
    health.retirementSignal.addEventListener('abort', () => { subscription.dispose(); edgeSubscription?.dispose(); }, { once: true });
    if (health.retirementSignal.aborted) { subscription.dispose(); edgeSubscription?.dispose(); }
    return health;
}

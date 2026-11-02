import { selectDeploymentRuntimeTargetLinkV1 } from '../projection/deploymentSelectors.js';
import type { createDeploymentProjectionV1 } from '../projection/deploymentStore.js';
import type { DeploymentEnvironmentReadDetailV1, DeploymentReadScopeV1, DeploymentReadTransportV1 } from './deploymentReadControllerTypes.js';

export type DeploymentEnvironmentHealthObservationV1 = {
    basis: string;
    abort: AbortController;
    stop?: () => void;
};
type Entry = {
    projection: ReturnType<typeof createDeploymentProjectionV1>;
    healthObservation: DeploymentEnvironmentHealthObservationV1 | undefined;
};

/** Metadata and receipt progress preserve health; protection changes its aggregate semantics. */
export function deploymentEnvironmentHealthBasisV1(detail: DeploymentEnvironmentReadDetailV1): string {
    const link = selectDeploymentRuntimeTargetLinkV1(detail);
    return JSON.stringify([link?.id ?? null, detail.environment.protection,
        detail.environment.ingress?.kind === 'edgeCaddy' ? [link?.revision, detail.environment.controllerMachineId,
            detail.environment.ingress.edgeMachineId] : null,
        link?.members.filter(member => member.state === 'active')
        .map(member => JSON.stringify([member.machineId, member.installationId])).sort() ?? []]);
}

export function stopDeploymentEnvironmentHealthObservationV1(entry: Entry): void {
    const observation = entry.healthObservation;
    if (!observation) return;
    entry.healthObservation = undefined;
    observation.abort.abort();
    observation.stop?.();
}

/** The controller's existing projection and demand entries own this subscription. */
export function reconcileDeploymentEnvironmentHealthObservationV1(entry: Entry, enabled: boolean,
    scope: DeploymentReadScopeV1, transport: DeploymentReadTransportV1): void {
    const detail = entry.projection.getSnapshot().value as DeploymentEnvironmentReadDetailV1 | null;
    if (!enabled || !detail || !transport.observeEnvironmentHealth) {
        stopDeploymentEnvironmentHealthObservationV1(entry);
        return;
    }
    const basis = deploymentEnvironmentHealthBasisV1(detail);
    if (entry.healthObservation?.basis === basis) return;
    stopDeploymentEnvironmentHealthObservationV1(entry);
    const observation: DeploymentEnvironmentHealthObservationV1 = { basis, abort: new AbortController() };
    entry.healthObservation = observation;
    observation.stop = transport.observeEnvironmentHealth(scope, detail, healthFeed => {
        if (observation.abort.signal.aborted) return;
        const snapshot = entry.projection.getSnapshot();
        if (snapshot.value) entry.projection.publish({ ...snapshot,
            value: { ...snapshot.value as DeploymentEnvironmentReadDetailV1, healthFeed } });
    }, { signal: observation.abort.signal });
}

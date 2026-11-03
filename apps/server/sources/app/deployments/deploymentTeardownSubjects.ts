import type { DeploymentAcceptedExecutionV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol';
import { getDeploymentTargetLinkLineageV1 } from '@happier-dev/deployment-protocol';
import type { Tx } from '@/storage/inTx';
import { readDeploymentTargetsInTx } from './deploymentTargetLinkService';

type Link = NonNullable<Awaited<ReturnType<Tx['deploymentTargetLink']['findUnique']>>> & {
    machines: Awaited<ReturnType<Tx['deploymentTargetLinkMachine']['findMany']>>;
};

/** Settlement and disposition read the same installation custody. Plugin account
 * targets execute on their captured controller when no scalar target is placed. */

export async function readDeploymentTeardownSubjectsInTx(tx: Tx, link: Link,
    accepted: DeploymentAcceptedExecutionV1 | null, runtimeTargetLinkId: string | null,
    knownLinks?: readonly DeploymentTargetLinkHeaderV1[],
) {
    const subjects = link.machines.length ? link.machines.map(member => ({ machineId: member.machineId, installationId: member.installationId }))
        : link.machineId && link.installationId ? [{ machineId: link.machineId, installationId: link.installationId }]
            : link.sourceKind === 'plugin' && accepted ? [accepted.controller] : [];
    if (link.sourceKind !== 'host' || link.targetKind !== 'ownServer' || !runtimeTargetLinkId || runtimeTargetLinkId === link.id) return subjects;
    const links = knownLinks ?? await readDeploymentTargetsInTx(tx, link.environmentId);
    const successor = links.find(value => value.id === runtimeTargetLinkId && value.deletedAtMs === undefined && value.detachedAtMs === undefined);
    if (!successor || successor.source.kind !== 'host' || successor.targetKind !== 'ownServer'
        || successor.source.id !== link.hostTargetId || !getDeploymentTargetLinkLineageV1(successor, links).has(link.id)) return subjects;
    // Only an admitted own-server successor inherits the same workload. Sharing
    // a Machine with a plugin resource does not transfer that resource's custody.
    return subjects.filter(member => !successor.members.some(current => current.machineId === member.machineId
        && current.installationId === member.installationId));
}

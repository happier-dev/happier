import type { Tx } from '@/storage/inTx';
import { DeploymentTeardownProofV1Schema } from '@happier-dev/protocol';
import type { DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol';
import { readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { readDeploymentTeardownSubjectsInTx } from './deploymentTeardownSubjects';

type Link = NonNullable<Awaited<ReturnType<Tx['deploymentTargetLink']['findUnique']>>> & {
    machines: Awaited<ReturnType<Tx['deploymentTargetLinkMachine']['findMany']>>;
};


export async function hasCompleteTeardownInTx(tx: Tx, link: Link, teardownDeploymentIds: readonly string[] | undefined,
    runtimeTargetLinkId: string | null, knownLinks?: readonly DeploymentTargetLinkHeaderV1[]) {
    const latest = await tx.deployment.findFirst({ where: { environmentId: link.environmentId, targetLinkId: link.id },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] });
    const accepted = latest ? readDeploymentAcceptedExecution(latest) : null;
    const subjects = await readDeploymentTeardownSubjectsInTx(tx, link, accepted, runtimeTargetLinkId, knownLinks);
    if (link.machines.length > 0 && subjects.length === 0) return true;
    if (!latest) return link.state === 'configured' && !link.activeDeploymentId;
    if ((teardownDeploymentIds !== undefined && !teardownDeploymentIds.includes(latest.id))
        || latest.operation !== 'teardown' || latest.state !== 'succeeded'
        || !latest.settledAt || !accepted || link.activeDeploymentId) return false;
    const proof = DeploymentTeardownProofV1Schema.safeParse(latest.teardownProof);
    // Signed settlement advances once; canonical unlink/delete advances once
    // more. Only a retained read consumes that disposition, never new admission.
    const dispositionRevision = teardownDeploymentIds === undefined && link.deletedAt !== null ? 1 : 0;
    if (!proof.success || proof.data.targetLinkRevision + 1 + dispositionRevision !== link.revision
        || link.state !== (proof.data.retainedProviderResource ? 'provisioned' : 'configured')
        || proof.data.machines.length !== subjects.length
        || !subjects.every(member => proof.data.machines.some(proved => proved.machineId === member.machineId
            && proved.installationId === member.installationId))) return false;
    // A replacement installation cannot inherit an earlier installation's cleanup fact.
    const currentInstallations = new Map<string, string | null>();
    for (const ids of portableQueryChunks({ values: subjects.map(member => member.machineId), bindingsPerValue: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: { id: true, installationId: true } });
        for (const machine of machines) currentInstallations.set(machine.id, machine.installationId);
    }
    return subjects.every(member => currentInstallations.get(member.machineId) === member.installationId);
}

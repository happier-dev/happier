import { DeploymentTeardownProofV1Schema } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';

/** A newer attempt supersedes cleanup evidence even when it leaves U unchanged. */
export async function readLatestDeploymentTeardownInTx(tx: Tx, link: Readonly<{ id: string; environmentId: string }>) {
    const latest = await tx.deployment.findFirst({ where: { environmentId: link.environmentId, targetLinkId: link.id },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] });
    const accepted = latest ? readDeploymentAcceptedExecution(latest) : null;
    const parsed = DeploymentTeardownProofV1Schema.safeParse(latest?.teardownProof);
    return { latest, accepted, proof: latest?.operation === 'teardown' && latest.state === 'succeeded'
        && latest.settledAt && accepted && parsed.success ? parsed.data : null };
}

/** Selective reduction and whole-target disposition consume the same exact
 * installation cleanup fact; their owners supply the applicable proof revision. */
export async function hasCurrentDeploymentTeardownProofInTx(tx: Tx,
    teardown: Awaited<ReturnType<typeof readLatestDeploymentTeardownInTx>>,
    input: Readonly<{ targetLinkRevision: number; teardownDeploymentIds?: readonly string[];
        machines: readonly Readonly<{ machineId: string; installationId: string }>[] }>,
) {
    const { latest, proof } = teardown;
    if (!latest || !proof
        || input.teardownDeploymentIds !== undefined && !input.teardownDeploymentIds.includes(latest.id)
        || proof.targetLinkRevision !== input.targetLinkRevision || proof.machines.length !== input.machines.length
        || !input.machines.every(member => proof.machines.some(proved => proved.machineId === member.machineId
            && proved.installationId === member.installationId))) return false;
    // A replacement installation cannot inherit an earlier installation's cleanup fact.
    const currentInstallations = new Map<string, string | null>();
    for (const ids of portableQueryChunks({ values: input.machines.map(member => member.machineId), bindingsPerValue: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: { id: true, installationId: true } });
        for (const machine of machines) currentInstallations.set(machine.id, machine.installationId);
    }
    return input.machines.every(member => currentInstallations.get(member.machineId) === member.installationId);
}

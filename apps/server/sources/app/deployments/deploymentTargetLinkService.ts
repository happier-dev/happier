import { DeploymentTargetLinkHeaderV1Schema } from '@happier-dev/protocol';
import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { deploymentContentReference } from './deploymentStoredContent';

export function projectDeploymentTargetHeader(row: Prisma.DeploymentTargetLinkGetPayload<{ include: { machines: true } }>) {
    return DeploymentTargetLinkHeaderV1Schema.parse({
        v: 1, id: row.id, environmentId: row.environmentId, revision: row.revision, role: row.role,
        source: row.sourceKind === 'plugin'
            ? { kind: 'plugin', contribution: { pluginId: row.pluginId, localId: row.contributionLocalId } }
            : { kind: row.sourceKind, id: row.hostTargetId }, targetKind: row.targetKind, state: row.state,
        machines: row.machines.map(member => member.machineId),
        members: row.machines.map(member => ({ machineId: member.machineId, installationId: member.installationId, state: member.state })),
        ...(row.activeDeploymentId ? { activeDeploymentId: row.activeDeploymentId } : {}),
        ...(row.predecessorTargetLinkId ? { predecessorTargetLinkId: row.predecessorTargetLinkId } : {}),
        ...(row.machineId ? { machineId: row.machineId, installationId: row.installationId } : {}),
        ...deploymentContentReference(row), createdByAccountId: row.createdByAccountId,
        createdAtMs: row.createdAt.getTime(), updatedAtMs: row.updatedAt.getTime(),
        ...(row.deletedAt ? { deletedAtMs: row.deletedAt.getTime() } : {}),
        ...(row.detachedAt ? { detachedAtMs: row.detachedAt.getTime() } : {}),
    });
}


export function loadDeploymentTargetRowsInTx(tx: Tx, environmentId: string) {
    return tx.deploymentTargetLink.findMany({ where: { environmentId },
        include: { machines: { orderBy: { position: 'asc' } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

/** One demanded Environment read carries current and retained link custody. */

export async function readDeploymentTargetsInTx(tx: Tx, environmentId: string) {
    const rows = await loadDeploymentTargetRowsInTx(tx, environmentId);
    return rows.map(projectDeploymentTargetHeader);
}

/** Source-admitted associations keep one selected runtime and independent data links with retained predecessors. */

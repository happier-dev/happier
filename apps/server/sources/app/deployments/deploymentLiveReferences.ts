import { DeploymentTeardownDispositionV1Schema } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

/** A removeEnvironment teardown, the only Delete that removes the Environment record. */
export function isDeploymentEnvironmentRemoval(receipt: Readonly<{ operation: string; teardownProof: unknown }>): boolean {
    return receipt.operation === 'teardown' && DeploymentTeardownDispositionV1Schema.safeParse(receipt.teardownProof).success;
}

/**
 * Receipts of one Environment that a deployment in another live Environment descends from
 * through the immutable Promote and Rollback edges, in any Project Source. Archive retirement
 * (retention and Environment Delete) is the only consumer; its admitted executor reads this.
 * One query per lineage depth.
 */
export async function readLiveReferencedDeploymentIdsInTx(tx: Tx, environmentId: string,
    deploymentIds: readonly string[],
): Promise<ReadonlySet<string>> {
    const selected = new Set(deploymentIds);
    const parents = new Map<string, string[]>();
    const live: string[] = [];
    const seen = new Set(selected);
    let frontier = [...selected];
    while (frontier.length) {
        const next: string[] = [];
        for (const ids of portableQueryChunks({ values: frontier, bindingsPerValue: 2 })) {
            const children = await tx.deployment.findMany({ where: { OR: [
                { promotedFromDeploymentId: { in: [...ids] } }, { rollbackOfDeploymentId: { in: [...ids] } },
            ] }, select: { id: true, environmentId: true, promotedFromDeploymentId: true, rollbackOfDeploymentId: true,
                environment: { select: { deletedAt: true } } } });
            for (const child of children) {
                parents.set(child.id, [child.promotedFromDeploymentId, child.rollbackOfDeploymentId]
                    .filter((id): id is string => id !== null));
                if (child.environmentId !== environmentId && !child.environment.deletedAt) live.push(child.id);
                if (!seen.has(child.id)) { seen.add(child.id); next.push(child.id); }
            }
        }
        frontier = next;
    }
    const referenced = new Set<string>();
    const visited = new Set<string>();
    const pending = live.flatMap(id => parents.get(id) ?? []);
    while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        if (selected.has(id)) referenced.add(id);
        pending.push(...parents.get(id) ?? []);
    }
    return referenced;
}

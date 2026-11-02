import type { DeploymentMachineResultV1, DeploymentReceiptDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { getDeploymentTargetLinkLineageV1 } from '@happier-dev/deployment-protocol/v1';

export type DeploymentMemberVersionV1 = Readonly<{
    machineId: string;
    installationId: string;
    state: 'joining' | 'active';
    deploymentId: string | null;
    uncertain: boolean;
}>;

function provedVersion(result: DeploymentMachineResultV1): string | undefined {
    if (result.restoration === 'succeeded') return result.currentDeploymentId;
    if (result.restoration === 'failed' || result.restoration === 'outcome_unknown' || result.activation !== 'succeeded') return undefined;
    return result.currentDeploymentId;
}

export type DeploymentMemberVersionProjectionV1 = Readonly<{
    /** Receipts must arrive newest first by requestedAtMs, then id, descending. */
    addReceipt(receipt: DeploymentReceiptDetailV1): boolean;
    getVersions(): Readonly<Record<string, DeploymentMemberVersionV1>>;
}>;

/** Fold each demanded receipt once; completed installations need no older proof. */
export function createDeploymentMemberVersionProjectionV1(link: DeploymentTargetLinkHeaderV1,
    retainedLinks: readonly DeploymentTargetLinkHeaderV1[] = [],
): DeploymentMemberVersionProjectionV1 {
    // Replacement keeps the same workload on common installations. Only its
    // admitted predecessor chain can carry older proof into current membership.
    const lineage = getDeploymentTargetLinkLineageV1(link, retainedLinks);
    const unresolved = new Set(link.members.map(member => member.machineId));
    const versions: Record<string, DeploymentMemberVersionV1> = Object.fromEntries(link.members.map(member =>
        [member.machineId, { ...member, deploymentId: null, uncertain: false }]));
    return {
        addReceipt(receipt) {
            if (!unresolved.size) return true;
            if (receipt.deployment.environmentId !== link.environmentId || !lineage.has(receipt.deployment.targetLinkId)) return false;
            const results = new Map(receipt.content.machineResults.map(result => [result.machineId, result]));
            const unknownMachines = receipt.deployment.state === 'outcome_unknown' ? new Set(receipt.content.machines) : null;
            for (const machineId of unresolved) {
                const member = versions[machineId]!;
                const result = results.get(machineId);
                if (result && result.installationId !== member.installationId) continue;
                const version = result && provedVersion(result);
                const restored = result?.restoration === 'succeeded' && version !== undefined;
                const uncertain = member.uncertain || !restored && (result?.activation === 'outcome_unknown'
                    || result?.restoration === 'outcome_unknown' || result?.restoration === 'failed'
                    || ((result?.activation === 'succeeded' || result?.restoration === 'succeeded') && !version)
                    || (unknownMachines?.has(machineId) === true && (!result || result.activation === 'pending')));
                versions[machineId] = { ...member, deploymentId: version ?? null, uncertain };
                if (version) unresolved.delete(machineId);
            }
            return unresolved.size === 0;
        },
        getVersions() {
            return Object.fromEntries(Object.entries(versions).map(([machineId, member]) =>
                [machineId, member.deploymentId === null ? { ...member, uncertain: true } : member]));
        },
    };
}

/** The caller supplies its already demanded retained-receipt window; this projection never reads history. */
export function deriveDeploymentMemberVersionsV1(link: DeploymentTargetLinkHeaderV1,
    receipts: readonly DeploymentReceiptDetailV1[],
    retainedLinks: readonly DeploymentTargetLinkHeaderV1[] = [],
): Readonly<Record<string, DeploymentMemberVersionV1>> {
    const projection = createDeploymentMemberVersionProjectionV1(link, retainedLinks);
    for (const receipt of [...receipts].sort((left, right) => right.deployment.requestedAtMs - left.deployment.requestedAtMs
        || right.deployment.id.localeCompare(left.deployment.id))) {
        if (projection.addReceipt(receipt)) break;
    }
    return projection.getVersions();
}

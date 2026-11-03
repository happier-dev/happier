import { DeploymentDomainCapturedPlacementsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';

type Captures = ReturnType<typeof DeploymentDomainCapturedPlacementsV1Schema.parse>;
function readCaptures(row: Readonly<{ capturedPlacements: unknown }>): Captures | null {
    const parsed = DeploymentDomainCapturedPlacementsV1Schema.safeParse(row.capturedPlacements);
    return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}
/** Reference disclosure projects only this Machine's admitted native placements. */
export function projectDeploymentDomainMachineReferences(row: Readonly<{ id: string; environmentId: string; capturedPlacements: unknown }>, machineId: string) {
    return (readCaptures(row) ?? []).filter(capture => capture.placement.machineId === machineId
        && capture.placement.domainId === row.id && capture.placement.environmentId === row.environmentId)
        .map(({ placement }) => ({ environmentId: row.environmentId, targetLinkId: placement.targetLinkId,
            domainId: row.id, machineId, installationId: placement.installationId }));
}

/** Database-side exact Machine selection keeps retained edge custody visible without an Account inventory scan. */
export async function readDeploymentDomainEnvironmentIdsForMachineInTx(tx: Tx,
    input: Readonly<{ machineId: string; afterEnvironmentId?: string; limit: number }>,
): Promise<string[]> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const needle = JSON.stringify([{ placement: { machineId: input.machineId } }]);
    let rows: { environmentId: string }[];
    if (provider === 'postgres') rows = await tx.$queryRawUnsafe(
        'SELECT DISTINCT "environmentId" FROM "DeploymentDomain" WHERE "deletedAt" IS NULL AND "capturedPlacements" @> $1::jsonb AND "environmentId" > $2 ORDER BY "environmentId" LIMIT $3',
        needle, input.afterEnvironmentId ?? '', input.limit);
    else if (provider === 'mysql') rows = await tx.$queryRawUnsafe(
        'SELECT DISTINCT `environmentId` FROM `DeploymentDomain` WHERE `deletedAt` IS NULL AND JSON_CONTAINS(`capturedPlacements`, CAST(? AS JSON)) AND `environmentId` > ? ORDER BY `environmentId` LIMIT ?',
        needle, input.afterEnvironmentId ?? '', input.limit);
    else rows = await tx.$queryRawUnsafe(
        'SELECT DISTINCT d."environmentId" FROM "DeploymentDomain" d, json_each(CASE WHEN json_type(d."capturedPlacements") = \'array\' THEN d."capturedPlacements" ELSE \'[]\' END) c WHERE d."deletedAt" IS NULL AND json_extract(c.value, \'$.placement.machineId\') = ? AND d."environmentId" > ? ORDER BY d."environmentId" LIMIT ?',
        input.machineId, input.afterEnvironmentId ?? '', input.limit);
    return rows.map(row => row.environmentId);
}

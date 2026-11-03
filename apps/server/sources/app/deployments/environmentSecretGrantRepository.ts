import { createHash } from 'node:crypto';
import { MachineSecretGrantV1Schema, machineSecretGrantSubjectKey,
    type MachineSecretGrantV1, type MachineConnectorSecretGrantSubjectV1 } from '@happier-dev/deployment-protocol';
import type { Tx } from '@/storage/inTx';

type GrantRow = NonNullable<Awaited<ReturnType<Tx['machineSecretGrant']['findUnique']>>>;


function invalidGrant(): never {
    throw Object.assign(new Error('An exact Environment installation grant is unavailable'), { code: 'secret_missing' });
}

/** Index encoding only; the public canonical subject remains the grant identity. */

function storageKey(grant: MachineSecretGrantV1 | MachineConnectorSecretGrantSubjectV1): string {
    return createHash('sha256').update(machineSecretGrantSubjectKey(grant)).digest('hex');
}

/** P21's admitted configure lifecycle is the Machine-scoped writer of the same installation table. */

function storedGrant(row: GrantRow): MachineSecretGrantV1 {
    const common = { v: 1, kind: row.kind, machineId: row.machineId,
        installationId: row.installationId, sealedContent: row.contentEnvelope };
    const parsed = MachineSecretGrantV1Schema.safeParse(row.kind === 'secret'
        ? { ...common, environmentId: row.environmentId, resourceId: row.resourceId, resourceRevision: row.resourceRevision }
        : row.kind === 'environmentValues'
            ? { ...common, environmentId: row.environmentId, binding: { purpose: 'variable', phase: row.phase, name: row.name } }
            : { ...common, provider: row.providerPluginId === null
                ? { kind: 'builtin', id: row.providerLocalId }
                : { pluginId: row.providerPluginId, localId: row.providerLocalId }, connectorId: row.connectorId });
    if (!parsed.success || storageKey(parsed.data) !== row.subjectKey) return invalidGrant();
    return parsed.data;
}


export async function readEnvironmentMachineSecretGrantsInTx(tx: Tx, input: Readonly<{
    environmentId: string;
    secret?: Readonly<{ resourceId: string; resourceRevision: number }>;
} & ({ machineId: string; installationId: string } | { machineId?: never; installationId?: never })>): Promise<readonly MachineSecretGrantV1[]> {
    const { secret, ...subject } = input;
    return (await tx.machineSecretGrant.findMany({ where: { ...subject, ...(secret ? { kind: 'secret', ...secret } : {}) },
        orderBy: { subjectKey: 'asc' } })).map(storedGrant);
}

/** Resource revision changes retire delivery authority, never incumbent memory sanitizers. */

import { DeploymentEnvironmentHeaderV1Schema } from '@happier-dev/protocol';
import { deploymentContentReference } from './deploymentStoredContent';
import { readDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/deployment-protocol';
import { projectEnvironmentSecretBindingRequiredUsesV1,
    type EnvironmentSecretRequiredUsesProjectionV1 } from '@happier-dev/deployments';
import { fetchRepeatKey } from '@/storage/queue/repeatKey';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { readProjectSourceCustodyInTx } from '@/app/projects/sources/projectSourceService';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveDeploymentEnvironmentAdmissionInTx, admitDeploymentMachineInTx, deploymentFailure, canDeployDeploymentEnvironment, type DeploymentSourceAdmission, type DeploymentAuthentication } from './deploymentAdmission';

export type DeploymentEnvironmentRow = NonNullable<Awaited<ReturnType<Tx['deploymentEnvironment']['findUnique']>>>;

export async function lockDeploymentEnvironmentInTx(tx: Tx, environmentId: string): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'postgres') await tx.$queryRawUnsafe('SELECT "id" FROM "DeploymentEnvironment" WHERE "id" = $1 FOR UPDATE', environmentId);
    if (provider === 'mysql') await tx.$queryRawUnsafe('SELECT `id` FROM `DeploymentEnvironment` WHERE `id` = ? FOR UPDATE', environmentId);
    // SQLite's existing serialized writer transaction owns its write exclusion.
}


export async function loadDeploymentEnvironmentInTx(tx: Tx, actorAccountId: string, serverId: string, environmentId: string,
    authentication: DeploymentAuthentication = {},
) {
    const row = await tx.deploymentEnvironment.findUnique({ where: { id: environmentId },
        include: { deployers: { select: { principalKind: true, principalId: true } } } });
    if (!row) return deploymentFailure('deployment_unavailable');
    const source = await resolveDeploymentEnvironmentAdmissionInTx(tx, actorAccountId, { serverId, projectSourceId: row.projectSourceId }, authentication);
    if (!source.ok) return source;
    return { ok: true as const, row, admission: source.admission };
}

/** Already installation-proved receipt readers consume the Source's Machine grant, independent of a custodian's Team membership. */
export async function loadDeploymentEnvironmentForInstalledMachineInTx(tx: Tx, input: Readonly<{
    serverId: string; environmentId: string; machineId: string; installationId: string;
}>) {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable');
    const row = await tx.deploymentEnvironment.findUnique({ where: { id: input.environmentId } });
    if (!row || row.deletedAt) return deploymentFailure('deployment_unavailable');
    const custody = await readProjectSourceCustodyInTx(tx, row.projectSourceId);
    if (!custody) return deploymentFailure('deployment_unavailable');
    const denied = await admitDeploymentMachineInTx(tx, custody.owner, input.machineId,
        row.buildMachineId === input.machineId ? 'build' : 'target', input.installationId);
    return denied ?? { ok: true as const, row, ...custody };
}

export async function readDeploymentEnvironmentRequiredSecretUsesInTx(tx: Tx,
    row: Pick<DeploymentEnvironmentRow, 'id' | 'runtimeTargetLinkId' | 'buildMachineId' | 'referencedSavedSecretRevisions'>,
): Promise<EnvironmentSecretRequiredUsesProjectionV1> {
    const captures = readDeploymentBindingSavedSecretRevisionsV1(row.referencedSavedSecretRevisions);
    if (!captures) return { status: 'incomplete', requiredSecretUses: [] };
    const link = row.runtimeTargetLinkId ? await tx.deploymentTargetLink.findFirst({
        where: { id: row.runtimeTargetLinkId, environmentId: row.id, deletedAt: null },
        include: { machines: { orderBy: { position: 'asc' } } },
    }) : null;
    const machineIds = [...new Set([...(link?.machines.map(member => member.machineId) ?? []),
        ...(row.buildMachineId ? [row.buildMachineId] : [])])];
    const installations = new Map<string, { machineId: string; installationId: string }>();
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] }, revokedAt: null,
            replacedByMachineId: null, account: { status: 'active' } },
        select: { id: true, installationId: true, installationPublicKey: true } });
        for (const machine of machines) if (machine.installationId && machine.installationPublicKey) {
            installations.set(machine.id, { machineId: machine.id, installationId: machine.installationId });
        }
    }
    const runtimeInstallations = !row.runtimeTargetLinkId ? [] : link && link.machines.length > 0 && link.machines.every(member =>
        installations.get(member.machineId)?.installationId === member.installationId)
        ? link.machines.map(member => installations.get(member.machineId)!) : null;
    const registryIds = [...new Set(captures.flatMap(capture => capture.requiredBindings?.flatMap(binding =>
        binding.purpose === 'registry' ? [binding.targetLinkId] : []) ?? []))];
    const currentRegistryTargetLinkIds: string[] = [];
    for (const ids of portableQueryChunks({ values: registryIds, bindingsPerValue: 1 })) {
        const links = await tx.deploymentTargetLink.findMany({ where: { id: { in: [...ids] },
            environmentId: row.id, deletedAt: null }, select: { id: true } });
        currentRegistryTargetLinkIds.push(...links.map(current => current.id));
    }
    return projectEnvironmentSecretBindingRequiredUsesV1({ referencedSavedSecretRevisions: captures,
        runtimeInstallations, ...(row.buildMachineId ? { buildInstallation: installations.get(row.buildMachineId) ?? null } : {}),
        currentRegistryTargetLinkIds });
}


function environmentCreationRepeatKey(actorAccountId: string, requestKey: string): string {
    return `deployments.environments.create:${actorAccountId}:${requestKey}`;
}

/** The host commitment covers copied content; random Artifact materialization is not a new reviewed intent. */

function parseEnvironmentCreationRepeatValue(value: string) {
    const [digest, environmentId] = value.split(':');
    return digest && environmentId ? { digest, environmentId } : null;
}

/** Resolve the existing acknowledged create intent; current Environment admission remains the caller's responsibility. */

export async function readCreatedDeploymentEnvironmentIdInTx(tx: Tx, actorAccountId: string, requestKey: string): Promise<string | null> {
    const value = await fetchRepeatKey(tx, environmentCreationRepeatKey(actorAccountId, requestKey), await readTransactionDatabaseTime(tx));
    return value ? parseEnvironmentCreationRepeatValue(value)?.environmentId ?? null : null;
}

/** Create an independent private-content relationship after destination management and optional copy-source admission. */

export function projectDeploymentEnvironmentHeader(row: DeploymentEnvironmentRow & Readonly<{ deployers?: readonly Readonly<{ principalKind: string; principalId: string }>[] }>, serverId: string, admission: DeploymentSourceAdmission) {
    const canDeploy = canDeployDeploymentEnvironment(admission, row);
    return DeploymentEnvironmentHeaderV1Schema.parse({
        v: 1, id: row.id, serverId, projectSourceId: row.projectSourceId, revision: row.revision,
        owner: admission.owner, protection: row.protection,
        purpose: row.purpose, deployerMode: row.deployerMode,
        ...(row.previewTemplateEnvironmentId ? { previewTemplateEnvironmentId: row.previewTemplateEnvironmentId,
            previewRepositoryId: row.previewRepositoryId, previewPullRequestId: row.previewPullRequestId,
            previewTargetLinkId: row.previewTargetLinkId } : {}),
        ...(row.deployers ? { deployerPrincipals: row.deployers.map(({ principalKind, principalId }) => ({ principalKind, principalId })) } : {}),
        controllerMachineId: row.controllerMachineId,
        ...(row.buildMachineId ? { buildMachineId: row.buildMachineId } : {}),
        // Full mode lives in protected content; null edge custody never implies Tunnel.
        ...(row.edgeMachineId ? { ingress: { kind: 'edgeCaddy', edgeMachineId: row.edgeMachineId } } : {}),
        ...(row.runtimeTargetLinkId ? { runtimeTargetLinkId: row.runtimeTargetLinkId } : {}),
        ...deploymentContentReference(row),
        capabilities: { role: admission.canManage ? 'manager' : canDeploy ? 'deployer' : 'reader',
            read: true, deploy: canDeploy, manage: admission.canManage && !row.deletedAt,
            manageBindings: admission.canManage && !row.deletedAt, manageTargets: admission.canManage && !row.deletedAt,
            delete: admission.canManage && !row.deletedAt },
        createdByAccountId: row.createdByAccountId, createdAtMs: row.createdAt.getTime(), updatedAtMs: row.updatedAt.getTime(),
        ...(row.deletedAt ? { deletedAtMs: row.deletedAt.getTime() } : {}),
    });
}

/** Every read and mutation resolves current Source authority rather than requester attribution. */

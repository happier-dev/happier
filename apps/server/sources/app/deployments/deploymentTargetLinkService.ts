import { DeploymentTargetLinkHeaderV1Schema, type DeploymentTargetLinkInputV1 } from '@happier-dev/protocol';
import type { Prisma } from '@prisma/client';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/deployment-protocol';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { getActivePrismaRuntime } from '@/storage/prisma';
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, saveRepeatKey } from '@/storage/queue/repeatKey';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { admitDeploymentDefinitionMachinesInTx, readDeploymentDefinitionMachinesInTx, deploymentFailure, type DeploymentAuthentication } from './deploymentAdmission';
import { admitDeploymentStoredContentInTx, deploymentContentReference } from './deploymentStoredContent';
import { deploymentIntentDigest, loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx, type AdmittedDeploymentEnvironment } from './deploymentEnvironmentService';
import { publishDeploymentChangesInTx } from './deploymentPublication';
import { deploymentInProgressStates } from './deploymentAcceptedExecution';

/** Plugin daemon roles use the selected scalar installation; native workloads use their member rows. */
export function readDeploymentTargetRuntimeInstallations(row: Readonly<{
    sourceKind: string;
    machineId: string | null;
    installationId: string | null;
    machines: readonly Readonly<{ machineId: string; installationId: string }>[];
}>): readonly Readonly<{ machineId: string; installationId: string }>[] {
    return row.sourceKind === 'plugin'
        ? row.machineId && row.installationId ? [{ machineId: row.machineId, installationId: row.installationId }] : []
        : row.machines;
}

/** One current relation owner validates every managed data-role link consumer. */
export async function readCurrentManagedDataTargetLinksInTx(tx: Tx, input: Readonly<{
    environmentId: string;
    targetLinkIds: readonly string[];
}>): Promise<readonly Readonly<{ id: string; revision: number; pluginId: string }>[] | null> {
    const requested = [...input.targetLinkIds];
    if (new Set(requested).size !== requested.length) return null;
    const links = new Map<string, Readonly<{ id: string; revision: number; pluginId: string }>>();
    for (const ids of portableQueryChunks({ values: requested, bindingsPerValue: 1, fixedBindings: 5 })) {
        const rows = await tx.deploymentTargetLink.findMany({ where: { id: { in: [...ids] }, environmentId: input.environmentId,
            role: 'data', sourceKind: 'plugin', deletedAt: null, detachedAt: null }, select: { id: true, revision: true, pluginId: true } });
        for (const row of rows) {
            if (!row.pluginId) return null;
            links.set(row.id, { id: row.id, revision: row.revision, pluginId: row.pluginId });
        }
    }
    return links.size === requested.length ? requested.map(id => links.get(id)!) : null;
}

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

export async function readDeploymentTargetInTx(tx: Tx, environmentId: string, targetLinkId: string) {
    const row = await tx.deploymentTargetLink.findFirst({ where: { id: targetLinkId, environmentId },
        include: { machines: { orderBy: { position: 'asc' } } } });
    return row ? projectDeploymentTargetHeader(row) : null;
}

/** One relational read supplies current and retained link custody. */
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
export async function linkDeploymentTargetInTx(tx: Tx, actorAccountId: string, input: DeploymentTargetLinkInputV1,
    authentication: DeploymentAuthentication = {},
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (loaded.row.deletedAt || !loaded.admission.canManage) return deploymentFailure('deployment_access_denied');
    const denied = await admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, loaded.admission.owner, [
        ...await readDeploymentDefinitionMachinesInTx(tx, loaded.row),
        ...input.machines, ...(input.machineId ? [{ machineId: input.machineId, installationId: input.installationId }] : []),
    ]);
    if (denied) return denied;
    return linkDeploymentTargetForAdmittedEnvironmentInTx(tx, actorAccountId, input, loaded);
}

/** Trusted write continuation: the public writer (or coupled create) already admitted Source and requester placement. */
export async function linkDeploymentTargetForAdmittedEnvironmentInTx(tx: Tx, actorAccountId: string, input: DeploymentTargetLinkInputV1,
    loaded: AdmittedDeploymentEnvironment,
    preparation?: Readonly<{ contentAdmitted: true }>,
) {
    const plugin = input.source?.kind === 'plugin' ? input.source : null;
    const contentFailure = preparation?.contentAdmitted ? null
        : await admitDeploymentStoredContentInTx(tx, actorAccountId, loaded.admission.owner, input, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1);
    if (contentFailure) return contentFailure;
    const now = await readTransactionDatabaseTime(tx);
    const repeatKey = `deployments.targets.link:${actorAccountId}:${input.environmentId}:${input.requestKey}`;
    const digest = deploymentIntentDigest(input);
    const repeated = await fetchRepeatKey(tx, repeatKey, now);
    if (repeated) {
        const [originalDigest, targetLinkId] = repeated.split(':');
        if (originalDigest !== digest || !targetLinkId) return deploymentFailure('deployment_conflict');
        const link = await tx.deploymentTargetLink.findFirst({ where: { id: targetLinkId, environmentId: input.environmentId, deletedAt: null, detachedAt: null } });
        return link ? { ok: true as const, environmentId: input.environmentId, revision: loaded.row.revision,
            targetLinkId: link.id, targetLinkRevision: link.revision } : deploymentFailure('deployment_conflict');
    }
    if (loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    const previous = input.replacesLinkId ? await tx.deploymentTargetLink.findFirst({ where: {
        id: input.replacesLinkId, environmentId: input.environmentId, deletedAt: null, detachedAt: null,
    }, include: { machines: { orderBy: { position: 'asc' } } } }) : null;
    const replacesPreviewData = input.replacesLinkId !== undefined && input.role === 'data';
    if (input.replacesLinkId) {
        if (!previous || previous.revision !== input.expectedTargetLinkRevision || previous.role !== input.role)
            return deploymentFailure('deployment_conflict');
        if (replacesPreviewData) {
            // The branch result replaces its child bootstrap scope without changing the
            // link identity already captured by the creating Workflow for teardown.
            if (loaded.row.purpose !== 'preview' || !loaded.row.previewTemplateEnvironmentId || !plugin
                || previous.sourceKind !== 'plugin' || previous.pluginId !== plugin.contribution.pluginId
                || previous.contributionLocalId !== plugin.contribution.localId || previous.targetKind !== input.targetKind
                || (previous.machineId ?? undefined) !== input.machineId
                || (previous.installationId ?? undefined) !== input.installationId) return deploymentFailure('deployment_conflict');
        } else if (input.role !== 'runtime' || loaded.row.runtimeTargetLinkId !== previous.id) return deploymentFailure('deployment_conflict');
        // Selection retains the complete predecessor and its native custody.
        // Teardown/unlink prove physical removal after Move has verified its destination.
        if (!plugin && previous.sourceKind === 'host' && previous.hostTargetId !== input.targetId)
            return deploymentFailure('deployment_conflict');
        const busy = await tx.deployment.findFirst({ where: { environmentId: input.environmentId,
            state: { in: deploymentInProgressStates() } }, select: { id: true } });
        if (busy) return { ok: false as const, error: 'deployment_in_progress' as const, deploymentId: busy.id,
            href: `/deployments/environments/${encodeURIComponent(input.environmentId)}/deployments/${encodeURIComponent(busy.id)}` };
    } else if (input.role === 'runtime' && loaded.row.runtimeTargetLinkId) return deploymentFailure('deployment_conflict');
    const retainsOwnServer = !plugin && previous?.sourceKind === 'host';
    const link = replacesPreviewData && previous
        ? await tx.deploymentTargetLink.update({ where: { id: previous.id }, data: {
            ...deploymentContentReference(input), revision: { increment: 1 },
        } })
        : await tx.deploymentTargetLink.create({ data: {
        environmentId: input.environmentId, role: input.role,
        ...(plugin ? { sourceKind: 'plugin', pluginId: plugin.contribution.pluginId, contributionLocalId: plugin.contribution.localId,
            machineId: input.machineId, installationId: input.installationId }
            : { sourceKind: 'host', hostTargetId: input.targetId }),
        targetKind: plugin ? input.targetKind! : 'ownServer',
        state: retainsOwnServer ? previous.state : input.provisioned ? 'provisioned' : 'configured',
        createdByAccountId: actorAccountId, ...deploymentContentReference(input),
        ...(previous ? { predecessorTargetLinkId: previous.id,
            ...(retainsOwnServer ? { activeDeploymentId: previous.activeDeploymentId } : {}) } : {}),
        machines: { create: input.machines.map((machine, position) => ({ ...machine, position,
            state: previous?.machines.find(member => member.machineId === machine.machineId && member.installationId === machine.installationId)?.state ?? 'joining' })) },
    } });
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: input.expectedRevision },
        data: { ...(input.role === 'runtime' ? { runtimeTargetLinkId: link.id, pendingDeployContent: getActivePrismaRuntime().DbNull } : {}),
            revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during target association');
    await saveRepeatKey(tx, repeatKey, `${digest}:${link.id}`, defaultRepeatKeyExpiresAt(now));
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, loaded.row.revision + 1);
    return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision + 1,
        targetLinkId: link.id, targetLinkRevision: link.revision };
}

import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import type { AccountErasureDeploymentBlockerV1 } from '@happier-dev/protocol/home/governance';
import type { AccountErasurePreviewResponseV1 } from '@happier-dev/protocol/auth/accountErasureReview';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { resolveProjectSourceAudiencesInTx, sourceFromRow, sourceOwner } from '@/app/projects/sources/projectSourceService';
import { readProjectSourceContentReferencesInTx } from '@/app/projects/sources/projectSourceContentReferences';
import { deploymentInProgressStates } from './deploymentAcceptedExecution';
import { readDeploymentTargetCleanupBlockerInTx } from './deploymentDispositionService';
import { readDeploymentPendingContent } from './deploymentPendingService';
import { clearErasedAccountDeploymentEnvironmentReferencesInTx } from '@/app/automations/automationDeploymentEnvironment';

/** Erasure disclosure opens only the deleting Account's shared Environment headers. */
export async function readAccountErasurePreviewInTx(tx: Tx, accountId: string): Promise<AccountErasurePreviewResponseV1> {
    const owned = await tx.projectSource.findMany({
        where: {
            createdByAccountId: accountId,
            NOT: { audience: { equals: [] } },
            deploymentEnvironments: { some: { createdByAccountId: accountId, deletedAt: null } },
        },
        orderBy: { id: 'asc' },
        include: { deploymentEnvironments: {
            where: { createdByAccountId: accountId, deletedAt: null },
            orderBy: { id: 'asc' },
            select: { id: true, contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true },
        } },
    });
    const shared = owned.flatMap(row => {
        const parsed = sourceFromRow(row);
        if (!parsed.success || parsed.data.audience.length === 0) return [];
        const owner = sourceOwner(parsed.data);
        return owner.kind === 'account' && owner.accountId === accountId ? [{ row, source: parsed.data }] : [];
    });
    const audiences = await resolveProjectSourceAudiencesInTx(tx, shared.map(entry => entry.source));
    return { sharedEnvironments: shared.flatMap(({ row }, index) => {
        const memberCount = audiences[index].filter(id => id !== accountId).length;
        if (!memberCount) return [];
        return row.deploymentEnvironments.map(({ id, ...content }) => ({ environmentId: id, memberCount, ...content }));
    }) };
}

const refused = (reason: AccountErasureDeploymentBlockerV1['reason'], scope: Omit<AccountErasureDeploymentBlockerV1, 'reason'> = {}) =>
    ({ status: 'rejected' as const, code: 'account_erasure_deployment_cleanup_required' as const, blocker: { reason, ...scope } });
type PurgeDecision = ReturnType<typeof refused> | Readonly<{ status: 'ok' }>;

async function forIds(values: readonly string[], mutate: (ids: string[]) => Promise<unknown>, fixedBindings = 0): Promise<void> {
    for (const ids of portableQueryChunks({ values, bindingsPerValue: 1, fixedBindings })) await mutate([...ids]);
}

/** Erasure owns admission and the transaction. Deployment owns closure, native
 * retirement evidence and FK order. Preflight performs the identical read-only
 * decision before erasure revokes credentials; purge runs after blob cleanup.
 * Neither phase grants authority to erase an Account or another person's graph.
 */
export async function purgeRetiredAccountDeploymentGraphInTx(tx: Tx, input: Readonly<{
    accountId: string; preflight?: boolean;
}>): Promise<PurgeDecision> {
    const { accountId } = input;
    const busy = deploymentInProgressStates();
    // A requester can still have an in-flight operation on another Source.
    // Settled authorship is history and adds no Source to this Account's scope.
    const requested = await tx.deployment.findFirst({ where: { requestedByAccountId: accountId, state: { in: busy } },
        orderBy: { id: 'asc' }, select: { id: true } });
    if (requested) return refused('running_work', { deploymentId: requested.id });
    const artifacts = await tx.artifact.findMany({ where: { accountId }, select: { id: true } });
    // The database clears settled Receipt references when their Artifact is erased.
    const references = await readProjectSourceContentReferencesInTx(tx, { artifactIds: artifacts.map(row => row.id), receiptStates: busy });
    const runningContent = references.find(ref => ref.expectedStoredKind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1);
    if (runningContent) return refused('running_work', { artifactId: runningContent.contentArtifactId });
    const authored = await tx.deploymentEnvironment.findMany({ where: { createdByAccountId: accountId },
        select: { projectSourceId: true } });
    const ownedSources = await tx.projectSource.findMany({ where: { createdByAccountId: accountId } });
    const authoredSourceIds = new Set(authored.map(row => row.projectSourceId));
    const sourceIds = new Set([...ownedSources.map(row => row.id), ...authoredSourceIds,
        ...references.map(row => row.projectSourceId)]);
    for (const row of await tx.deploymentTargetLink.findMany({ where: { createdByAccountId: accountId },
        select: { environment: { select: { projectSourceId: true } } } })) sourceIds.add(row.environment.projectSourceId);
    for (const row of await tx.deploymentDomain.findMany({ where: { createdByAccountId: accountId },
        select: { environment: { select: { projectSourceId: true } } } })) sourceIds.add(row.environment.projectSourceId);
    for (const row of await tx.deploymentEnvironmentDeployer.findMany({ where: { createdByAccountId: accountId },
        select: { environment: { select: { projectSourceId: true } } } })) sourceIds.add(row.environment.projectSourceId);
    const machines = await tx.machine.findMany({ where: { accountId }, select: { id: true } });
    // Include foreign graphs that would otherwise block Machine deletion. Each
    // arm follows its own FK index rather than OR-ing correlated relation arms.
    for (const ids of portableQueryChunks({ values: machines.map(row => row.id), bindingsPerValue: 1 })) {
        const machineIds = [...ids];
        for (const field of ['controllerMachineId', 'buildMachineId', 'edgeMachineId', 'telemetryMachineId'] as const) {
            for (const row of await tx.deploymentEnvironment.findMany({ where: { [field]: { in: machineIds } },
                select: { projectSourceId: true } })) sourceIds.add(row.projectSourceId);
        }
        const links = await tx.deploymentTargetLink.findMany({ where: { machineId: { in: machineIds } },
            select: { environment: { select: { projectSourceId: true } } } });
        const members = await tx.deploymentTargetLinkMachine.findMany({ where: { machineId: { in: machineIds } },
            select: { targetLink: { select: { environment: { select: { projectSourceId: true } } } } } });
        for (const row of links) sourceIds.add(row.environment.projectSourceId);
        for (const row of members) sourceIds.add(row.targetLink.environment.projectSourceId);
    }
    const sources = [];
    for (const ids of portableQueryChunks({ values: [...sourceIds], bindingsPerValue: 1 })) {
        sources.push(...await tx.projectSource.findMany({ where: { id: { in: [...ids] } }, include: {
            deploymentDefaults: true,
            deploymentEnvironments: { include: { targetLinks: { include: { machines: true } },
                deployments: true, domains: true, automations: { select: { accountId: true, deletedAt: true } } } },
        } }));
    }
    const environments = sources.flatMap(row => row.deploymentEnvironments);
    const environmentIds = environments.map(row => row.id);
    const environmentSet = new Set(environmentIds);
    const links = environments.flatMap(row => row.targetLinks);
    const linkIds = links.map(row => row.id);
    const linkSet = new Set(linkIds);
    const receipts = environments.flatMap(row => row.deployments);
    const receiptIds = receipts.map(row => row.id);
    const receiptSet = new Set(receiptIds);
    const retiredTeamSources = [];
    for (const source of sources) {
        if (!source.deploymentDefaults && source.deploymentEnvironments.length === 0) continue;
        const parsed = sourceFromRow(source);
        const createdByEraser = source.createdByAccountId === accountId;
        const scope = createdByEraser ? { projectSourceId: source.id } : {};
        if (!parsed.success) return refused('graph_dependencies', scope);
        const owner = sourceOwner(parsed.data);
        if (owner.kind === 'account' && owner.accountId === accountId && createdByEraser) continue;
        if (owner.kind === 'team' && source.deletedAt !== null
            && (createdByEraser || authoredSourceIds.has(source.id))
            && source.deploymentEnvironments.every(environment => environment.deletedAt !== null)) {
            retiredTeamSources.push({ source: parsed.data, teamId: owner.teamId, scope, createdByEraser });
            continue;
        }
        return refused('source_sharing', scope);
    }
    // Retired Environments can still have readable history through their Source.
    const audiences = await resolveProjectSourceAudiencesInTx(tx, retiredTeamSources.map(entry => entry.source));
    const archivedTeamIds = new Set<string>();
    for (const ids of portableQueryChunks({ values: [...new Set(retiredTeamSources.map(entry => entry.teamId))],
        bindingsPerValue: 1 })) {
        const teams = await tx.team.findMany({ where: { id: { in: [...ids] }, archivedAt: { not: null } }, select: { id: true } });
        for (const team of teams) archivedTeamIds.add(team.id);
    }
    const retiredSharedGraphIds = new Set<string>();
    for (const [index, entry] of retiredTeamSources.entries()) {
        if (audiences[index].some(id => id !== accountId)) return refused('source_sharing', entry.scope);
        if (archivedTeamIds.has(entry.teamId)) retiredSharedGraphIds.add(entry.source.id);
        else if (!entry.createdByEraser) return refused('source_sharing', entry.scope);
    }

    // Physical cleanup can include other authors' retired rows. The erasing
    // Account only gets links to its own rows in a refusal.
    const refuseGraph = (reason: AccountErasureDeploymentBlockerV1['reason'],
        scope: Omit<AccountErasureDeploymentBlockerV1, 'reason'> = {}) => {
        const { projectSourceId, environmentId, targetLinkId, targetKind, deploymentId } = scope;
        const ownsEnvironment = (id: string) => environments.some(row => row.id === id && row.createdByAccountId === accountId);
        const ownsTarget = targetLinkId && links.some(link => link.id === targetLinkId && link.createdByAccountId === accountId);
        return refused(reason, {
            ...(projectSourceId && ownedSources.some(source => source.id === projectSourceId) ? { projectSourceId } : {}),
            ...(environmentId && ownsEnvironment(environmentId) ? { environmentId } : {}),
            ...(ownsTarget ? { targetLinkId, ...(targetKind ? { targetKind } : {}) } : {}),
            ...(deploymentId && receipts.some(row => row.id === deploymentId && ownsEnvironment(row.environmentId)) ? { deploymentId } : {}),
        });
    };
    for (const row of environments) {
        const retiredSharedGraph = retiredSharedGraphIds.has(row.projectSourceId);
        const blocksByAuthorship = (authorAccountId: string) => !retiredSharedGraph && authorAccountId !== accountId;
        if (blocksByAuthorship(row.createdByAccountId)) {
            return refuseGraph('graph_dependencies', { projectSourceId: row.projectSourceId });
        }
        const scope = { environmentId: row.id };
        const pending = readDeploymentPendingContent(row);
        const running = row.deployments.find(receipt => busy.includes(receipt.state));
        if (running || pending.ok && pending.pendingDeploy) return refuseGraph('running_work', {
            ...scope, ...(running ? { deploymentId: running.id } : {}),
        });
        const domainTargets = new Set(row.targetLinks.map(link => link.id));
        if (!pending.ok || row.runtimeTargetLinkId && !domainTargets.has(row.runtimeTargetLinkId)) {
            return refuseGraph('graph_dependencies', scope);
        }
        if (row.domains.some(domain =>
            !domainTargets.has(domain.targetLinkId) || blocksByAuthorship(domain.createdByAccountId))) {
            return refuseGraph('graph_dependencies', scope);
        }
        const activeDomainTargets = new Set(row.domains.filter(domain => !domain.deletedAt).map(domain => domain.targetLinkId));
        for (const link of row.targetLinks) {
            if (blocksByAuthorship(link.createdByAccountId)) return refuseGraph('graph_dependencies', scope);
            const target = { ...scope, targetLinkId: link.id, targetKind: link.targetKind };
            if (link.activeDeploymentId && !receiptSet.has(link.activeDeploymentId)) return refuseGraph('graph_dependencies', target);
            const blocker = await readDeploymentTargetCleanupBlockerInTx(tx, link, row.runtimeTargetLinkId, activeDomainTargets.has(link.id));
            if (blocker) return refuseGraph(blocker, target);
        }
        if (row.automations.some(automation => automation.accountId !== accountId && !automation.deletedAt)) {
            return refuseGraph('foreign_automation', scope);
        }
    }
    // Outgoing references leave the referenced rows intact. Incoming foreign
    // references to this Account's rows need their owner's cooperation.
    for (const ids of portableQueryChunks({ values: environmentIds, bindingsPerValue: 1 })) {
        for (const field of ['previewTemplateEnvironmentId', 'previewCompanionOfEnvironmentId'] as const) {
            const reference = (await tx.deploymentEnvironment.findMany({ where: { [field]: { in: [...ids] } },
                select: { id: true, previewTemplateEnvironmentId: true, previewCompanionOfEnvironmentId: true } }))
                .find(row => !environmentSet.has(row.id));
            const environmentId = reference?.[field];
            if (environmentId) return refuseGraph('graph_dependencies', { environmentId });
        }
    }
    for (const ids of portableQueryChunks({ values: linkIds, bindingsPerValue: 1 })) {
        const successor = (await tx.deploymentTargetLink.findMany({ where: { predecessorTargetLinkId: { in: [...ids] } },
            select: { id: true, predecessorTargetLinkId: true } })).find(row => !linkSet.has(row.id));
        if (successor?.predecessorTargetLinkId) return refuseGraph('graph_dependencies', { targetLinkId: successor.predecessorTargetLinkId });
        for (const field of ['runtimeTargetLinkId', 'previewTargetLinkId'] as const) {
            const reference = (await tx.deploymentEnvironment.findMany({ where: { [field]: { in: [...ids] } },
                select: { id: true, runtimeTargetLinkId: true, previewTargetLinkId: true } })).find(row => !environmentSet.has(row.id));
            const targetLinkId = reference?.[field];
            if (targetLinkId) return refuseGraph('graph_dependencies', { targetLinkId });
        }
        const receipt = (await tx.deployment.findMany({ where: { targetLinkId: { in: [...ids] } },
            select: { id: true, targetLinkId: true } })).find(row => !receiptSet.has(row.id));
        if (receipt) return refuseGraph('graph_dependencies', { targetLinkId: receipt.targetLinkId });
        const domain = (await tx.deploymentDomain.findMany({ where: { targetLinkId: { in: [...ids] } },
            select: { environmentId: true, targetLinkId: true } })).find(row => !environmentSet.has(row.environmentId));
        if (domain) return refuseGraph('graph_dependencies', { targetLinkId: domain.targetLinkId });
    }
    for (const ids of portableQueryChunks({ values: receiptIds, bindingsPerValue: 1 })) {
        for (const field of ['predecessorDeploymentId', 'rollbackOfDeploymentId', 'promotedFromDeploymentId'] as const) {
            const reference = (await tx.deployment.findMany({ where: { [field]: { in: [...ids] } },
                select: { id: true, predecessorDeploymentId: true, rollbackOfDeploymentId: true, promotedFromDeploymentId: true } }))
                .find(row => !receiptSet.has(row.id));
            const deploymentId = reference?.[field];
            if (deploymentId) return refuseGraph('graph_dependencies', { deploymentId });
        }
        const link = (await tx.deploymentTargetLink.findMany({ where: { activeDeploymentId: { in: [...ids] } },
            select: { id: true, activeDeploymentId: true } })).find(row => !linkSet.has(row.id));
        if (link?.activeDeploymentId) return refuseGraph('graph_dependencies', { deploymentId: link.activeDeploymentId });
    }
    for (const ids of portableQueryChunks({ values: [...sourceIds], bindingsPerValue: 1 })) {
        const preview = (await tx.deploymentEnvironment.findMany({ where: { previewRepositoryId: { in: [...ids] } },
            select: { id: true, previewRepositoryId: true } })).find(row => !environmentSet.has(row.id));
        if (preview?.previewRepositoryId) return refuseGraph('graph_dependencies', { projectSourceId: preview.previewRepositoryId });
    }
    for (const row of receipts) {
        if (!linkSet.has(row.targetLinkId)) return refuseGraph('graph_dependencies', { deploymentId: row.id });
    }
    if (input.preflight) return { status: 'ok' as const };
    // All references are admitted as one graph. Break cycles, then remove
    // leaves before owners. No external side effects occur inside this Tx.
    await clearErasedAccountDeploymentEnvironmentReferencesInTx(tx, { accountId, environmentIds });
    // The preview CHECK applies until deletion, including to tombstones.
    // Clear the whole preview identity in the same write that changes purpose.
    await forIds(environmentIds, ids => tx.deploymentEnvironment.updateMany({ where: { id: { in: ids } }, data: {
        purpose: 'standard', runtimeTargetLinkId: null, previewTemplateEnvironmentId: null,
        previewRepositoryId: null, previewPullRequestId: null, previewTargetLinkId: null,
        previewCompanionOfEnvironmentId: null,
    } }), 8);
    await forIds(linkIds, ids => tx.deploymentTargetLink.updateMany({ where: { id: { in: ids } }, data: { activeDeploymentId: null, predecessorTargetLinkId: null } }), 3);
    await forIds(receiptIds, ids => tx.deployment.updateMany({ where: { id: { in: ids } }, data: {
        predecessorDeploymentId: null, rollbackOfDeploymentId: null, promotedFromDeploymentId: null } }), 3);
    await forIds(environmentIds, ids => tx.deploymentDomain.deleteMany({ where: { environmentId: { in: ids } } }));
    await forIds(receiptIds, ids => tx.deployment.deleteMany({ where: { id: { in: ids } } }));
    await forIds(linkIds, ids => tx.deploymentTargetLinkMachine.deleteMany({ where: { targetLinkId: { in: ids } } }));
    await forIds(linkIds, ids => tx.deploymentTargetLink.deleteMany({ where: { id: { in: ids } } }));
    await forIds(environmentIds, ids => tx.deploymentEnvironmentDeployer.deleteMany({ where: { environmentId: { in: ids } } }));
    await forIds(environmentIds, ids => tx.deploymentEnvironment.deleteMany({ where: { id: { in: ids } } }));
    await forIds([...sourceIds], ids => tx.projectDeploymentDefaults.deleteMany({ where: { projectSourceId: { in: ids } } }));
    return { status: 'ok' as const };
}

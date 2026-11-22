import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { sourceFromRow, sourceOwner } from '@/app/projects/sources/projectSourceService';
import { readProjectSourceContentReferencesInTx } from '@/app/projects/sources/projectSourceContentReferences';
import { deploymentInProgressStates } from './deploymentAcceptedExecution';
import { hasCompleteTeardownInTx } from './deploymentDispositionService';
import { readDeploymentPendingContent } from './deploymentPendingService';
import { clearErasedAccountDeploymentEnvironmentReferencesInTx } from '@/app/automations/automationDeploymentEnvironment';

const refused = () => ({ status: 'rejected' as const, code: 'account_erasure_deployment_cleanup_required' as const });
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
    if (await tx.deployment.findFirst({ where: { requestedByAccountId: accountId, state: { in: busy } },
        select: { id: true } })) return refused();
    const artifacts = await tx.artifact.findMany({ where: { accountId }, select: { id: true } });
    const references = await readProjectSourceContentReferencesInTx(tx, { artifactIds: artifacts.map(row => row.id) });
    const authored = await tx.deploymentEnvironment.findMany({ where: { createdByAccountId: accountId },
        select: { projectSourceId: true } });
    const ownedSources = await tx.projectSource.findMany({ where: { createdByAccountId: accountId } });
    const sourceIds = new Set([...ownedSources.map(row => row.id), ...authored.map(row => row.projectSourceId),
        ...references.map(row => row.projectSourceId)]);
    for (const row of await tx.deploymentTargetLink.findMany({ where: { createdByAccountId: accountId },
        select: { environment: { select: { projectSourceId: true } } } })) sourceIds.add(row.environment.projectSourceId);
    for (const row of await tx.deploymentDomain.findMany({ where: { createdByAccountId: accountId },
        select: { environment: { select: { projectSourceId: true } } } })) sourceIds.add(row.environment.projectSourceId);
    for (const row of await tx.deploymentEnvironmentDeployer.findMany({ where: { createdByAccountId: accountId },
        select: { environment: { select: { projectSourceId: true } } } })) sourceIds.add(row.environment.projectSourceId);
    const machines = await tx.machine.findMany({ where: { accountId }, select: { id: true } });
    const machineIds = new Set(machines.map(row => row.id));
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
                deployments: true, domains: true, principals: true, automations: { select: { accountId: true, enabled: true } },
                machineSecretGrants: { select: { subjectKey: true } } } },
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
    const definitionArtifactIds = new Set([...environments.map(row => row.contentArtifactId), ...links.map(row => row.contentArtifactId),
        ...environments.flatMap(row => row.domains.map(domain => domain.contentArtifactId)),
        ...sources.flatMap(row => row.deploymentDefaults?.contentArtifactId ? [row.deploymentDefaults.contentArtifactId] : [])]);
    const artifactIds = [...new Set([...definitionArtifactIds, ...receipts.map(row => row.contentArtifactId)])];
    for (const source of sources) {
        if (!source.deploymentDefaults && source.deploymentEnvironments.length === 0) continue;
        const parsed = sourceFromRow(source);
        if (!parsed.success) return refused();
        const owner = sourceOwner(parsed.data);
        if (owner.kind !== 'account' || owner.accountId !== accountId || source.createdByAccountId !== accountId
            || parsed.data.audience.some(grant => grant.principal.kind !== 'account' || grant.principal.accountId !== accountId)) return refused();
    }
    for (const row of environments) {
        const pending = readDeploymentPendingContent(row);
        if (!pending.ok || pending.pendingDeploy) return refused();
        // Source continuity treats a non-deleted Environment as live controller
        // custody, even if its last receipt settled and no workload is selected.
        if (row.createdByAccountId !== accountId || !row.deletedAt || row.runtimeTargetLinkId
            || [row.controllerMachineId, row.buildMachineId, row.edgeMachineId, row.telemetryMachineId]
                .some(id => id && !machineIds.has(id))
            || row.automations.some(automation => automation.accountId !== accountId || automation.enabled) || row.machineSecretGrants.length
            || row.principals.some(principal => principal.createdByAccountId !== accountId
                || principal.principalKind !== 'account' || principal.principalId !== accountId)
            || row.domains.some(domain => domain.createdByAccountId !== accountId || !domain.deletedAt || !linkSet.has(domain.targetLinkId))
            || row.deployments.some(receipt => busy.includes(receipt.state))) return refused();
        for (const link of row.targetLinks) {
            if (link.createdByAccountId !== accountId
                || link.state === 'provisioned'
                || link.machineId && !machineIds.has(link.machineId)
                || link.machines.some(member => !machineIds.has(member.machineId))
                || link.predecessorTargetLinkId && !linkSet.has(link.predecessorTargetLinkId)
                || link.activeDeploymentId && !receiptSet.has(link.activeDeploymentId)
                || !await hasCompleteTeardownInTx(tx, link, undefined, row.runtimeTargetLinkId)) return refused();
        }
    }
    // Incoming lineage and private content references must close over this
    // graph before any FK is cleared. Artifact sharing remains Artifact-owned.
    const purgeArtifactIds: string[] = [];
    for (const ids of portableQueryChunks({ values: artifactIds, bindingsPerValue: 1 })) {
        const rows = await tx.artifact.findMany({ where: { id: { in: [...ids] } }, include: {
            grants: true, keyEnvelopes: true, publicShare: true, signedInLink: true, templateAcceptedVersions: true,
        } });
        if (rows.length !== ids.length) return refused();
        const ownedIds: string[] = [];
        for (const row of rows) {
            if (row.accountId !== accountId) {
                // Drop the retired Receipt's reference to a foreign Artifact.
                // Its bytes and ownership remain with that Artifact's Account.
                if (definitionArtifactIds.has(row.id)) return refused();
                continue;
            }
            if (row.publicShare || row.signedInLink || row.templateAcceptedVersions.length
                || row.grants.some(grant => grant.principalKind !== 'account' || grant.accountId !== accountId)
                || row.keyEnvelopes.some(envelope => envelope.recipientAccountId !== accountId)) return refused();
            ownedIds.push(row.id);
        }
        const refs = await readProjectSourceContentReferencesInTx(tx, { artifactIds: ownedIds });
        if (refs.some(ref => !sourceIds.has(ref.projectSourceId))) return refused();
        purgeArtifactIds.push(...ownedIds);
    }
    for (const ids of portableQueryChunks({ values: environmentIds, bindingsPerValue: 1 })) {
        for (const field of ['previewTemplateEnvironmentId', 'previewCompanionOfEnvironmentId'] as const) {
            if ((await tx.deploymentEnvironment.findMany({ where: { [field]: { in: [...ids] } }, select: { id: true } }))
                .some(row => !environmentSet.has(row.id))) return refused();
        }
    }
    for (const ids of portableQueryChunks({ values: linkIds, bindingsPerValue: 1 })) {
        if ((await tx.deploymentTargetLink.findMany({ where: { predecessorTargetLinkId: { in: [...ids] } }, select: { id: true } }))
            .some(row => !linkSet.has(row.id))) return refused();
        for (const field of ['runtimeTargetLinkId', 'previewTargetLinkId'] as const) {
            if ((await tx.deploymentEnvironment.findMany({ where: { [field]: { in: [...ids] } }, select: { id: true } }))
                .some(row => !environmentSet.has(row.id))) return refused();
        }
        if ((await tx.deployment.findMany({ where: { targetLinkId: { in: [...ids] } }, select: { id: true } }))
            .some(row => !receiptSet.has(row.id))) return refused();
        if ((await tx.deploymentDomain.findMany({ where: { targetLinkId: { in: [...ids] } }, select: { environmentId: true } }))
            .some(row => !environmentSet.has(row.environmentId))) return refused();
    }
    for (const ids of portableQueryChunks({ values: receiptIds, bindingsPerValue: 1 })) {
        for (const field of ['predecessorDeploymentId', 'rollbackOfDeploymentId', 'promotedFromDeploymentId'] as const) {
            if ((await tx.deployment.findMany({ where: { [field]: { in: [...ids] } }, select: { id: true } }))
                .some(row => !receiptSet.has(row.id))) return refused();
        }
        if ((await tx.deploymentTargetLink.findMany({ where: { activeDeploymentId: { in: [...ids] } }, select: { id: true } }))
            .some(row => !linkSet.has(row.id))) return refused();
    }
    for (const ids of portableQueryChunks({ values: [...sourceIds], bindingsPerValue: 1 })) {
        if ((await tx.deploymentEnvironment.findMany({ where: { previewRepositoryId: { in: [...ids] } }, select: { id: true } }))
            .some(row => !environmentSet.has(row.id))) return refused();
    }
    for (const row of environments) {
        if (row.previewTemplateEnvironmentId && !environmentSet.has(row.previewTemplateEnvironmentId)
            || row.previewCompanionOfEnvironmentId && !environmentSet.has(row.previewCompanionOfEnvironmentId)
            || row.previewRepositoryId && !sourceIds.has(row.previewRepositoryId)
            || row.previewTargetLinkId && !linkSet.has(row.previewTargetLinkId)) return refused();
    }
    for (const row of receipts) {
        if (!linkSet.has(row.targetLinkId)
            || [row.predecessorDeploymentId, row.rollbackOfDeploymentId, row.promotedFromDeploymentId].some(id => id && !receiptSet.has(id))) return refused();
    }
    if (input.preflight) return { status: 'ok' as const };
    // All references are admitted as one graph. Break cycles, then remove
    // leaves before owners. No external side effects occur inside this Tx.
    await clearErasedAccountDeploymentEnvironmentReferencesInTx(tx, { accountId, environmentIds });
    await forIds(environmentIds, ids => tx.deploymentEnvironment.updateMany({ where: { id: { in: ids } }, data: {
        previewTemplateEnvironmentId: null, previewCompanionOfEnvironmentId: null, previewTargetLinkId: null } }), 4);
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
    await forIds(purgeArtifactIds, ids => tx.artifact.deleteMany({ where: { id: { in: ids }, accountId } }), 1);
    return { status: 'ok' as const };
}

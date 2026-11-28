import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { DeploymentEnvironmentDeleteInputV1, DeploymentTargetUnlinkInputV1,
    DeploymentEnvironmentDeleteResultV1, DeploymentTargetUnlinkResultV1 } from '@happier-dev/protocol';
import type { DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, saveRepeatKey } from '@/storage/queue/repeatKey';
import { disableDeploymentEnvironmentAutomationsInTx } from '@/app/automations/automationDeploymentEnvironment';
import { deploymentFailure, admitDeploymentDefinitionMachinesInTx, readDeploymentDefinitionMachinesInTx,
    type DeploymentAuthentication } from './deploymentAdmission';
import { deploymentIntentDigest, loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx,
    type DeploymentEnvironmentRow, type AdmittedDeploymentEnvironment } from './deploymentEnvironmentService';
import { deploymentInProgressStates } from './deploymentAcceptedExecution';
import { readDeploymentPendingContent } from './deploymentPendingService';
import { readDeploymentDomainInventoryInTx } from './deploymentDomainService';
import { clearedDeploymentTelemetryPendingAssignment, publishDeploymentChangesInTx, publishDeploymentTelemetryMachinesInTx } from './deploymentPublication';
import { withdrawEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';
import { readDeploymentTeardownSubjectsInTx } from './deploymentTeardownSubjects';
import { readLatestDeploymentTeardownInTx, hasCurrentDeploymentTeardownProofInTx } from './deploymentTeardownProof';
import { loadDeploymentTargetRowsInTx, projectDeploymentTargetHeader, readDeploymentTargetLinkState } from './deploymentTargetLinkService';
import { readDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { publishSavedSecretUsageChangesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { prepareDeploymentAppMachineRevocationInTx } from './deploymentAppRevocation';
import { resolveProjectSourceAudienceInTx } from '@/app/projects/sources/projectSourceService';

type DispositionInput = Pick<DeploymentEnvironmentDeleteInputV1,
    'serverId' | 'environmentId' | 'expectedRevision' | 'requestKey' | 'detachKeepRunning'>;

type Link = NonNullable<Awaited<ReturnType<Tx['deploymentTargetLink']['findUnique']>>> & {
    machines: Awaited<ReturnType<Tx['deploymentTargetLinkMachine']['findMany']>>;
};

function targetDisposition(now: Date, disposition: 'keep-running' | 'transferred' | 'removed') {
    return {
        deletedAt: now,
        ...(disposition === 'keep-running' ? { detachedAt: now, state: 'detached' }
            : disposition === 'transferred' ? { state: 'none', activeDeploymentId: null } : {}),
        revision: { increment: 1 },
    };
}

async function hasTransferredDeploymentCustodyInTx(tx: Tx, link: Link, runtimeTargetLinkId: string | null,
    knownLinks?: readonly DeploymentTargetLinkHeaderV1[]) {
    return link.machines.length > 0
        && (await readDeploymentTeardownSubjectsInTx(tx, link, null, runtimeTargetLinkId, knownLinks)).length === 0;
}

const teardownRequired = () => ({ ok: false as const, error: 'deployment_teardown_required' as const });

function readAcknowledgement(value: string, digest: string) {
    const [originalDigest, revisionText, targetRevisionText, detached] = value.split(':');
    const revision = Number(revisionText), targetLinkRevision = Number(targetRevisionText);
    return originalDigest === digest && Number.isSafeInteger(revision) && revision > 0
        && Number.isSafeInteger(targetLinkRevision) && targetLinkRevision >= 0 && (detached === '0' || detached === '1')
        ? { revision, targetLinkRevision, detached: detached === '1' } : null;
}

/** Current proof is shared with Source custody; disposition additionally requires its supplied receipt ids. */
export async function hasCompleteTeardownInTx(tx: Tx, link: Link, teardownDeploymentIds: readonly string[] | undefined,
    runtimeTargetLinkId: string | null, knownLinks?: readonly DeploymentTargetLinkHeaderV1[]) {
    return (await readDeploymentTargetRemovalInTx(tx, link, teardownDeploymentIds, runtimeTargetLinkId, knownLinks)) !== null;
}

async function readDeploymentTargetRemovalInTx(tx: Tx, link: Link, teardownDeploymentIds: readonly string[] | undefined,
    runtimeTargetLinkId: string | null, knownLinks?: readonly DeploymentTargetLinkHeaderV1[]) {
    if (await hasTransferredDeploymentCustodyInTx(tx, link, runtimeTargetLinkId, knownLinks)) return 'transferred' as const;
    return await hasCompleteTeardownProofInTx(tx, link, teardownDeploymentIds, runtimeTargetLinkId,
        await readLatestDeploymentTeardownInTx(tx, link), knownLinks) ? 'removed' as const : null;
}

/** Native absence and released management custody are separate facts. */
export async function readDeploymentTargetCleanupBlockerInTx(tx: Tx, link: Link, runtimeTargetLinkId: string | null,
    hasManagedDomain: boolean) {
    const state = readDeploymentTargetLinkState(link);
    if (state === 'detached') return null;
    const teardown = await readLatestDeploymentTeardownInTx(tx, link);
    const { latest } = teardown;
    if (latest?.operation === 'teardown' && latest.startedAt && latest.state !== 'succeeded') return 'teardown_incomplete' as const;
    if (hasManagedDomain || state === 'provisioned' || state === 'deployed') return 'provider_resource' as const;
    if (await hasTransferredDeploymentCustodyInTx(tx, link, runtimeTargetLinkId)) return null;
    return await hasCompleteTeardownProofInTx(tx, link, undefined, runtimeTargetLinkId, teardown) ? null : 'provider_resource' as const;
}

async function hasCompleteTeardownProofInTx(tx: Tx, link: Link, teardownDeploymentIds: readonly string[] | undefined,
    runtimeTargetLinkId: string | null, teardown: Awaited<ReturnType<typeof readLatestDeploymentTeardownInTx>>,
    knownLinks?: readonly DeploymentTargetLinkHeaderV1[]) {
    const state = readDeploymentTargetLinkState(link);
    if (teardownDeploymentIds === undefined && state === 'none' && link.deletedAt && !link.activeDeploymentId
        && link.sourceKind === 'host' && link.targetKind === 'ownServer' && link.machines.length > 0) return true;
    const subjects = await readDeploymentTeardownSubjectsInTx(tx, link, teardown.accepted, runtimeTargetLinkId, knownLinks);
    if (!teardown.latest) return state === 'configured' && !link.activeDeploymentId;
    const { proof } = teardown;
    if (!proof || link.activeDeploymentId
        || state !== 'detached' && state !== (proof.retainedProviderResource ? 'provisioned' : 'configured')) return false;
    // Signed settlement advances once; canonical unlink/delete advances once
    // more. Only a retained read consumes that disposition, never new admission.
    const dispositionRevision = teardownDeploymentIds === undefined && link.deletedAt !== null ? 1 : 0;
    return hasCurrentDeploymentTeardownProofInTx(tx, teardown, { teardownDeploymentIds,
        targetLinkRevision: link.revision - 1 - dispositionRevision, machines: subjects });
}

function installations(links: readonly Link[]) {
    return links.flatMap(link => [...link.machines.map(member => ({ machineId: member.machineId, installationId: member.installationId })),
        ...(link.machineId && link.installationId ? [{ machineId: link.machineId, installationId: link.installationId }] : [])]);
}

async function admitDispositionInTx(tx: Tx, actorAccountId: string, input: DispositionInput,
    authentication: DeploymentAuthentication,
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (!loaded.admission.canManage) return deploymentFailure('deployment_access_denied');
    return loaded;
}

async function admitDispositionMachinesInTx(tx: Tx, actorAccountId: string, loaded: AdmittedDeploymentEnvironment,
    detachKeepRunning: boolean | undefined,
) {
    const { row, admission: { owner } } = loaded;
    const machines = await readDeploymentDefinitionMachinesInTx(tx, row);
    if (!detachKeepRunning || owner.kind !== 'account' || owner.accountId !== actorAccountId) {
        return admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, owner, machines);
    }
    // Explicit detach only releases Home's records. A Source owner can release
    // their own revoked placements even though those Machines cannot admit work.
    const revoked = new Set<string>();
    const machineIds = [...new Set(machines.map(machine => machine.machineId))];
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const rows = await tx.machine.findMany({ where: {
            id: { in: [...ids] }, accountId: actorAccountId, revokedAt: { not: null },
        }, select: { id: true } });
        for (const machine of rows) revoked.add(machine.id);
    }
    return admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, owner,
        machines.filter(machine => !revoked.has(machine.machineId)));
}

async function dispositionDependenciesInTx(tx: Tx, input: DispositionInput,
    row: Extract<Awaited<ReturnType<typeof loadDeploymentEnvironmentInTx>>, { ok: true }>['row'],
) {
    const busy = await tx.deployment.findFirst({ where: { environmentId: input.environmentId,
        state: { in: deploymentInProgressStates() } }, select: { id: true }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }] });
    if (busy) return { ok: false as const, error: 'deployment_in_progress' as const, deploymentId: busy.id,
        href: `/deployments/environments/${encodeURIComponent(input.environmentId)}/deployments/${encodeURIComponent(busy.id)}` };
    const pending = readDeploymentPendingContent(row);
    if (!pending.ok) return pending;
    return pending.pendingDeploy ? deploymentFailure('deployment_conflict') : null;
}

/** Dispose only the association; native resources belong to the teardown owner. */
export async function unlinkDeploymentTargetInTx(tx: Tx, actorAccountId: string,
    input: DeploymentTargetUnlinkInputV1,
    authentication: DeploymentAuthentication = {},
): Promise<DeploymentTargetUnlinkResultV1> {
    const loaded = await admitDispositionInTx(tx, actorAccountId, input, authentication);
    if (!loaded.ok) return loaded;
    const now = await readTransactionDatabaseTime(tx);
    const key = `deployments.targets.unlink:${actorAccountId}:${input.environmentId}:${input.requestKey}`;
    const digest = deploymentIntentDigest(input);
    const repeated = await fetchRepeatKey(tx, key, now);
    if (repeated) {
        const result = readAcknowledgement(repeated, digest);
        return result ? { ok: true as const, environmentId: input.environmentId, targetLinkId: input.targetLinkId, ...result }
            : deploymentFailure('deployment_conflict');
    }
    if (loaded.row.deletedAt) return deploymentFailure('deployment_unavailable', { phase: 'deployment.target.unlink.environment', causeKind: 'already_deleted' });
    if (loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: input.targetLinkId, environmentId: input.environmentId,
        deletedAt: null, detachedAt: null }, include: { machines: true } });
    if (!link) return deploymentFailure('deployment_unavailable', { phase: 'deployment.target.unlink.load', causeKind: 'not_found' });
    if (link.revision !== input.expectedTargetLinkRevision) return deploymentFailure('deployment_conflict');
    const denied = await admitDispositionMachinesInTx(tx, actorAccountId, loaded, input.detachKeepRunning);
    if (denied) return denied;
    const dependency = await dispositionDependenciesInTx(tx, input, loaded.row);
    if (dependency) return dependency;
    const inventory = await readDeploymentDomainInventoryInTx(tx, actorAccountId, input, authentication, loaded);
    if (!inventory.ok) return inventory;
    const disposition = input.detachKeepRunning ? 'keep-running'
        : inventory.domains.some(domain => domain.targetLinkId === link.id) ? null
            : await readDeploymentTargetRemovalInTx(tx, link, input.teardownDeploymentId ? [input.teardownDeploymentId] : [], loaded.row.runtimeTargetLinkId);
    if (!disposition) return teardownRequired();
    const selected = loaded.row.runtimeTargetLinkId === link.id;
    // P42 grants serve only the selected runtime and builder. Data/retiring
    // associations cannot retain delivery authority after runtime removal.
    const remaining = !selected && loaded.row.runtimeTargetLinkId ? await tx.deploymentTargetLink.findFirst({ where: {
        id: loaded.row.runtimeTargetLinkId, environmentId: loaded.row.id, deletedAt: null, detachedAt: null,
    }, include: { machines: true } }) : null;
    const retained = installations(remaining ? [remaining] : []);
    if (!selected && loaded.row.buildMachineId) {
        const builder = await tx.machine.findUnique({ where: { id: loaded.row.buildMachineId }, select: { id: true, installationId: true } });
        if (builder?.installationId) retained.push({ machineId: builder.id, installationId: builder.installationId });
    }
    if (selected) await disableDeploymentEnvironmentAutomationsInTx(tx, loaded.row.id);
    await withdrawEnvironmentSecretGrantsInTx(tx, { environmentId: loaded.row.id,
        ...(!selected ? { withdrawnInstallations: installations([link]), retainedInstallations: retained } : {}) });
    const changed = await tx.deploymentTargetLink.updateMany({ where: { id: link.id, revision: link.revision },
        data: targetDisposition(now, disposition) });
    if (changed.count !== 1) throw new Error('Locked deployment link changed during disposition');
    const environment = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: loaded.row.revision },
        data: { ...(selected ? { runtimeTargetLinkId: null, ...clearedDeploymentTelemetryPendingAssignment } : {}), revision: { increment: 1 } } });
    if (environment.count !== 1) throw new Error('Locked deployment Environment changed during disposition');
    const revision = loaded.row.revision + 1, targetLinkRevision = link.revision + 1;
    await saveRepeatKey(tx, key, `${digest}:${revision}:${targetLinkRevision}:${input.detachKeepRunning ? 1 : 0}`, defaultRepeatKeyExpiresAt(now));
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, revision);
    return { ok: true as const, environmentId: loaded.row.id, revision, targetLinkId: link.id,
        targetLinkRevision, detached: input.detachKeepRunning === true };
}

/** Tombstone an Environment only after every dependent association is admitted. */
export async function deleteDeploymentEnvironmentInTx(tx: Tx, actorAccountId: string,
    input: DeploymentEnvironmentDeleteInputV1,
    authentication: DeploymentAuthentication = {},
): Promise<DeploymentEnvironmentDeleteResultV1> {
    const loaded = await admitDispositionInTx(tx, actorAccountId, input, authentication);
    if (!loaded.ok) return loaded;
    const now = await readTransactionDatabaseTime(tx);
    const key = `deployments.environments.delete:${actorAccountId}:${input.environmentId}:${input.requestKey}`;
    const digest = deploymentIntentDigest(input);
    const repeated = await fetchRepeatKey(tx, key, now);
    if (repeated) {
        const result = readAcknowledgement(repeated, digest);
        return result ? { ok: true as const, environmentId: input.environmentId, revision: result.revision, detached: result.detached }
            : deploymentFailure('deployment_conflict');
    }
    if (loaded.row.deletedAt) return deploymentFailure('deployment_unavailable', { phase: 'deployment.environment.delete', causeKind: 'already_deleted' });
    if (loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    const denied = await admitDispositionMachinesInTx(tx, actorAccountId, loaded, input.detachKeepRunning);
    if (denied) return denied;
    const dependency = await dispositionDependenciesInTx(tx, input, loaded.row);
    if (dependency) return dependency;
    const links = await loadDeploymentTargetRowsInTx(tx, input.environmentId);
    const inventory = await readDeploymentDomainInventoryInTx(tx, actorAccountId, input, authentication, loaded);
    if (!inventory.ok) return inventory;
    const transferredLinkIds: string[] = [];
    if (!input.detachKeepRunning) {
        if (inventory.domains.length) return teardownRequired();
        // Retained intermediates carry lineage even though only active links need teardown.
        const knownLinks = links.map(projectDeploymentTargetHeader);
        for (const link of links.filter(link => !link.deletedAt && !link.detachedAt)) {
            const disposition = await readDeploymentTargetRemovalInTx(tx, link, input.teardownDeploymentIds ?? [],
                loaded.row.runtimeTargetLinkId, knownLinks);
            if (!disposition) return teardownRequired();
            if (disposition === 'transferred') transferredLinkIds.push(link.id);
        }
    }
    const revision = await removeAdmittedDeploymentEnvironmentInTx(tx, { environment: loaded.row,
        source: loaded.admission.source, now, detachKeepRunning: input.detachKeepRunning, transferredLinkIds });
    await saveRepeatKey(tx, key, `${digest}:${revision}:0:${input.detachKeepRunning ? 1 : 0}`, defaultRepeatKeyExpiresAt(now));
    return { ok: true as const, environmentId: loaded.row.id, revision, detached: input.detachKeepRunning === true };
}


/** The existing disposition writer spends either ordinary delete admission or the captured teardown disposition. */
export async function removeAdmittedDeploymentEnvironmentInTx(tx: Tx, input: Readonly<{
    environment: DeploymentEnvironmentRow; source: AdmittedDeploymentEnvironment['admission']['source'];
    now: Date; detachKeepRunning?: boolean; knownAccountIds?: readonly string[];
    revokeAppMachines?: () => Promise<void>; transferredLinkIds?: readonly string[];
}>): Promise<number> {
    const { environment, now } = input;
    const revokeAppMachines = input.revokeAppMachines ?? await prepareDeploymentAppMachineRevocationInTx(tx, {
        environmentId: environment.id,
        publicationAccountIds: input.knownAccountIds ?? await resolveProjectSourceAudienceInTx(tx, [input.source]),
        disableEnvironmentAutomations: {}, environmentRemoval: { telemetryMachineId: environment.telemetryMachineId,
            savedSecretResourceIds: (readDeploymentBindingSavedSecretRevisionsV1(environment.referencedSavedSecretRevisions) ?? []).map(capture => capture.resourceId) },
    });
    await revokeAppMachines();
    await disableDeploymentEnvironmentAutomationsInTx(tx, environment.id);
    await withdrawEnvironmentSecretGrantsInTx(tx, { environmentId: environment.id });
    if (!input.detachKeepRunning && environment.runtimeTargetLinkId) {
        let transferredLinkIds = input.transferredLinkIds;
        if (!transferredLinkIds) {
            // Signed settlement still has the selected Link and its lineage before tombstoning.
            const links = await loadDeploymentTargetRowsInTx(tx, environment.id);
            const knownLinks = links.map(projectDeploymentTargetHeader);
            const transferred: string[] = [];
            for (const link of links) {
                if (link.deletedAt || link.detachedAt) continue;
                if (await hasTransferredDeploymentCustodyInTx(tx, link, environment.runtimeTargetLinkId, knownLinks)) {
                    transferred.push(link.id);
                }
            }
            transferredLinkIds = transferred;
        }
        for (const ids of portableQueryChunks({ values: transferredLinkIds, bindingsPerValue: 1, fixedBindings: 6 })) {
            await tx.deploymentTargetLink.updateMany({
                where: { environmentId: environment.id, id: { in: [...ids] }, deletedAt: null, detachedAt: null },
                data: targetDisposition(now, 'transferred'),
            });
        }
    }
    await tx.deploymentTargetLink.updateMany({ where: { environmentId: environment.id, deletedAt: null, detachedAt: null },
        data: targetDisposition(now, input.detachKeepRunning ? 'keep-running' : 'removed') });
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: environment.id, revision: environment.revision },
        data: { deletedAt: now, runtimeTargetLinkId: null, telemetryMachineId: null, telemetryTokenHash: null, ...clearedDeploymentTelemetryPendingAssignment,
            revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during deletion');
    await publishSavedSecretUsageChangesInTx(tx,
        (readDeploymentBindingSavedSecretRevisionsV1(environment.referencedSavedSecretRevisions) ?? []).map(capture => capture.resourceId));
    const revision = environment.revision + 1;
    await publishDeploymentTelemetryMachinesInTx(tx, [environment.telemetryMachineId]);
    await publishDeploymentChangesInTx(tx, input, environment.id, revision, undefined, true, input.knownAccountIds);
    return revision;
}

/** Admit all remaining association cleanup once, before this teardown can remove its Environment. */
export async function admitDeploymentTeardownEnvironmentRemovalInTx(tx: Tx, input: Readonly<{
    loaded: AdmittedDeploymentEnvironment; targetLinkId: string;
}>) {
    const links = await loadDeploymentTargetRowsInTx(tx, input.loaded.row.id);
    const knownLinks = links.map(projectDeploymentTargetHeader);
    for (const link of links.filter(link => link.id !== input.targetLinkId && !link.deletedAt && !link.detachedAt)) {
        if (!await hasCompleteTeardownInTx(tx, link, undefined, input.loaded.row.runtimeTargetLinkId, knownLinks)) return teardownRequired();
    }
    return null;
}

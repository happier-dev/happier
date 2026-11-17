import type { Tx } from '@/storage/inTx';
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
import { publishDeploymentChangesInTx, publishDeploymentTelemetryMachinesInTx } from './deploymentPublication';
import { withdrawEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';
import { readDeploymentTeardownSubjectsInTx } from './deploymentTeardownSubjects';
import { readLatestDeploymentTeardownInTx, hasCurrentDeploymentTeardownProofInTx } from './deploymentTeardownProof';
import { loadDeploymentTargetRowsInTx, projectDeploymentTargetHeader } from './deploymentTargetLinkService';
import { readDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { publishSavedSecretUsageChangesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { revokeDeploymentAppMachinesInTx } from './deploymentAppRevocation';

type DispositionInput = Pick<DeploymentEnvironmentDeleteInputV1,
    'serverId' | 'environmentId' | 'expectedRevision' | 'requestKey' | 'detachKeepRunning'>;

type Link = NonNullable<Awaited<ReturnType<Tx['deploymentTargetLink']['findUnique']>>> & {
    machines: Awaited<ReturnType<Tx['deploymentTargetLinkMachine']['findMany']>>;
};

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
    const teardown = await readLatestDeploymentTeardownInTx(tx, link);
    const subjects = await readDeploymentTeardownSubjectsInTx(tx, link, teardown.accepted, runtimeTargetLinkId, knownLinks);
    if (link.machines.length > 0 && subjects.length === 0) return true;
    if (!teardown.latest) return link.state === 'configured' && !link.activeDeploymentId;
    const { proof } = teardown;
    if (!proof || link.activeDeploymentId
        || link.state !== (proof.retainedProviderResource ? 'provisioned' : 'configured')) return false;
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
    const denied = await admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, loaded.admission.owner,
        await readDeploymentDefinitionMachinesInTx(tx, loaded.row));
    if (denied) return denied;
    const dependency = await dispositionDependenciesInTx(tx, input, loaded.row);
    if (dependency) return dependency;
    const inventory = await readDeploymentDomainInventoryInTx(tx, actorAccountId, input, authentication, loaded);
    if (!inventory.ok) return inventory;
    if (!input.detachKeepRunning && (inventory.domains.some(domain => domain.targetLinkId === link.id)
        || !await hasCompleteTeardownInTx(tx, link, input.teardownDeploymentId ? [input.teardownDeploymentId] : [], loaded.row.runtimeTargetLinkId))) return teardownRequired();
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
        data: { deletedAt: now, ...(input.detachKeepRunning ? { detachedAt: now } : {}), revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment link changed during disposition');
    const environment = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: loaded.row.revision },
        data: { ...(selected ? { runtimeTargetLinkId: null } : {}), revision: { increment: 1 } } });
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
    const denied = await admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, loaded.admission.owner,
        await readDeploymentDefinitionMachinesInTx(tx, loaded.row));
    if (denied) return denied;
    const dependency = await dispositionDependenciesInTx(tx, input, loaded.row);
    if (dependency) return dependency;
    const links = await loadDeploymentTargetRowsInTx(tx, input.environmentId);
    const inventory = await readDeploymentDomainInventoryInTx(tx, actorAccountId, input, authentication, loaded);
    if (!inventory.ok) return inventory;
    if (!input.detachKeepRunning) {
        if (inventory.domains.length) return teardownRequired();
        // Retained intermediates carry lineage even though only active links need teardown.
        const knownLinks = links.map(projectDeploymentTargetHeader);
        for (const link of links.filter(link => !link.deletedAt && !link.detachedAt)) {
            if (!await hasCompleteTeardownInTx(tx, link, input.teardownDeploymentIds ?? [], loaded.row.runtimeTargetLinkId, knownLinks)) return teardownRequired();
        }
    }
    const revision = await removeAdmittedDeploymentEnvironmentInTx(tx, { environment: loaded.row,
        source: loaded.admission.source, now, detachKeepRunning: input.detachKeepRunning });
    await saveRepeatKey(tx, key, `${digest}:${revision}:0:${input.detachKeepRunning ? 1 : 0}`, defaultRepeatKeyExpiresAt(now));
    return { ok: true as const, environmentId: loaded.row.id, revision, detached: input.detachKeepRunning === true };
}


/** The existing disposition writer spends either ordinary delete admission or the captured teardown disposition. */
export async function removeAdmittedDeploymentEnvironmentInTx(tx: Tx, input: Readonly<{
    environment: DeploymentEnvironmentRow; source: AdmittedDeploymentEnvironment['admission']['source'];
    now: Date; detachKeepRunning?: boolean; knownAccountIds?: readonly string[];
}>): Promise<number> {
    const { environment, now } = input;
    await revokeDeploymentAppMachinesInTx(tx, { environmentId: environment.id });
    await disableDeploymentEnvironmentAutomationsInTx(tx, environment.id);
    await withdrawEnvironmentSecretGrantsInTx(tx, { environmentId: environment.id });
    await tx.deploymentTargetLink.updateMany({ where: { environmentId: environment.id, deletedAt: null, detachedAt: null },
        data: { deletedAt: now, ...(input.detachKeepRunning ? { detachedAt: now } : {}), revision: { increment: 1 } } });
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: environment.id, revision: environment.revision },
        data: { deletedAt: now, runtimeTargetLinkId: null, telemetryMachineId: null, telemetryTokenHash: null, revision: { increment: 1 } } });
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

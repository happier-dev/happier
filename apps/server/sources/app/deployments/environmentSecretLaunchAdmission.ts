import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectEnvironmentSecretBindingRequiredUsesV1, selectEnvironmentSecretCapturePurposesV1 } from '@happier-dev/deployments';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, EnvironmentSecretLaunchAdmissionResultV1Schema, type EnvironmentSecretAdmissionRequestV1, type EnvironmentSecretLaunchAdmissionResultV1, type MachineConnectorSecretGrantInputV1, type MachineConnectorSecretGrantResultV1 } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import type { DeploymentRestoreNativeAdmissionV1, DeploymentBackupNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import type { DeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { admitDeploymentMachineInTx, admitDeploymentMachinesInTx, canDeployDeploymentEnvironment, deploymentFailure, type DeploymentAuthentication } from './deploymentAdmission';
import { loadDeploymentEnvironmentInTx, loadDeploymentEnvironmentCustodyInTx, loadDeploymentEnvironmentForInstalledMachineInTx, projectDeploymentEnvironmentHeader } from './deploymentEnvironmentService';
import { readEnvironmentMachineSecretGrantsInTx, readMachineConnectorSecretGrantInTx,
    setMachineConnectorSecretGrantInTx } from './environmentSecretGrantRepository';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';
import { readAcceptedDeploymentDomainSecretDestinationInTx, readDeploymentDomainOperationalDestinationsInTx } from './deploymentDomainService';
import type { DeploymentChildAdmission } from './deploymentChildAuthorization';
import { readCurrentManagedDataTargetLinksInTx, readDeploymentTargetRuntimeInstallations } from './deploymentTargetLinkService';
import { readAdmittedDeploymentReadScopeInTx } from './deploymentReadAuthorization';

/** Machine setup storage admission; the configure invocation owns provider/operation currentness and plaintext custody. */
export async function accessMachineConnectorSecretGrantInTx(tx: Tx, actorAccountId: string,
    input: MachineConnectorSecretGrantInputV1,
    admittedChild?: DeploymentChildAdmission,
): Promise<MachineConnectorSecretGrantResultV1> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable');
    const { proof, ...body } = input;
    const hasInstalledProof = (publicKey: Uint8Array) => verifyMachineInstallationProof({ payload: { version: 1,
        accountId: actorAccountId, machineId: input.hostMachineId, installationId: input.hostInstallationId,
        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey });
    if (admittedChild) {
        // Authentication retained this request's one active Domain-job lookup.
        // Bind its exact signer and destination; do not re-admit Account/Manage.
        const admittedDomain = admittedChild.domainAdmission;
        const action = admittedChild.domainJob?.execution.actionId;
        const write = action === 'deployments.domains.add' ? 'set' : action === 'deployments.domains.remove' ? 'remove' : undefined;
        if (!admittedDomain || !write) return deploymentFailure('deployment_access_denied');
        const signer = input.operation === 'read' ? admittedDomain.target : admittedDomain.controller;
        if ((input.operation !== 'read' && input.operation !== write) || input.hostMachineId !== signer.machineId
            || input.hostInstallationId !== signer.installationId
            || input.subject.machineId !== admittedDomain.target.machineId
            || input.subject.installationId !== admittedDomain.target.installationId
            || !hasInstalledProof(decodeBase64(signer.publicKey, 'base64url'))) {
            return deploymentFailure('deployment_access_denied');
        }
    } else {
        const host = await tx.machine.findUnique({ where: { id: input.hostMachineId }, select: {
            installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true,
            account: { select: { status: true } },
        } });
        if (!host || host.account.status !== 'active' || host.revokedAt || host.replacedByMachineId
            || host.installationId !== input.hostInstallationId || !host.installationPublicKey) return deploymentFailure('deployment_access_denied');
        if (!hasInstalledProof(host.installationPublicKey)) return deploymentFailure('deployment_access_denied');
        const target = input.hostMachineId === input.subject.machineId ? host : await tx.machine.findUnique({ where: { id: input.subject.machineId }, select: {
            installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true,
        } });
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
            accountIds: [actorAccountId], machineIds: [input.hostMachineId, input.subject.machineId],
        });
        if (!target || target.revokedAt || target.replacedByMachineId || !target.installationPublicKey
            || target.installationId !== input.subject.installationId
            || access.get(input.hostMachineId)?.get(actorAccountId) !== 'manage'
            || access.get(input.subject.machineId)?.get(actorAccountId) !== 'manage') {
            return deploymentFailure('deployment_access_denied');
        }
    }
    if (input.operation === 'read') {
        if (input.hostMachineId !== input.subject.machineId || input.hostInstallationId !== input.subject.installationId) {
            return deploymentFailure('deployment_access_denied');
        }
        const grant = await readMachineConnectorSecretGrantInTx(tx, input.subject);
        return grant ? { ok: true, grant } : { ok: false, error: 'secret_missing' };
    }
    try {
        const grant = await setMachineConnectorSecretGrantInTx(tx, { subject: input.subject,
            grant: input.operation === 'set' ? input.grant : null });
        return grant ? { ok: true, grant } : { ok: true };
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'secret_missing') return { ok: false, error: 'secret_missing' };
        throw error;
    }
}

/** Private installed receiver and manager preparation admission; never an ordinary content projection. */
export async function readEnvironmentSecretLaunchAdmissionInTx(tx: Tx, actorAccountId: string,
    input: EnvironmentSecretAdmissionRequestV1, authentication: DeploymentAuthentication = {},
    admittedChild?: DeploymentChildAdmission,
    admittedBackup?: DeploymentRestoreNativeAdmissionV1 | DeploymentBackupNativeAdmissionV1,
    admittedDataQuery?: Extract<DeploymentReadAdmissionV1, { actionId: typeof DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 }>
        | Extract<DeploymentReadAdmissionV1, { actionId: typeof ACTION_INVOKE_ACTION_ID_V1 }>,
): Promise<EnvironmentSecretLaunchAdmissionResultV1> {
    if ('kind' in input) return readEnvironmentBindingPreparationInTx(tx, actorAccountId, input, authentication);
    const dataRole = input.materialization.kind === 'dataRole';
    const factsOnly = input.materialization.kind === 'domain' && !input.materialization.use;
    const domainAdmission = factsOnly ? admittedChild?.domainAdmission : undefined;
    let installationPublicKey: Uint8Array;
    if (factsOnly) {
        if (!domainAdmission || domainAdmission.controller.machineId !== input.machineId
            || domainAdmission.controller.installationId !== input.installationId) return deploymentFailure('deployment_access_denied');
        installationPublicKey = decodeBase64(domainAdmission.controller.publicKey, 'base64url');
    } else {
        const machine = await tx.machine.findUnique({ where: { id: input.machineId },
            select: { accountId: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true } });
        if (!machine || machine.installationId !== input.installationId
            || !machine.installationPublicKey || machine.revokedAt || machine.replacedByMachineId) {
            return deploymentFailure('deployment_access_denied', dataRole
                ? { phase: 'deployment.secret_launch.data_role.installation', causeKind: 'access_denied' } : undefined);
        }
        installationPublicKey = machine.installationPublicKey;
    }
    const { proof, ...body } = input;
    if (!verifyMachineInstallationProof({ payload: { version: 1, accountId: actorAccountId, machineId: input.machineId,
        installationId: input.installationId, deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
        proof, publicKey: installationPublicKey })) {
        return deploymentFailure('deployment_access_denied', dataRole
            ? { phase: 'deployment.secret_launch.data_role.installation_proof', causeKind: 'access_denied' } : undefined);
    }
    if (dataRole) {
        // HTTP binds the signed query operands; this scope owner decides their
        // current Environment/link custody. Service and binding selection stay
        // private to the host; another seal never selects a role.
        if (!admittedDataQuery && admittedBackup?.kind !== 'restore') {
            return deploymentFailure('deployment_access_denied', {
                phase: 'deployment.secret_launch.data_role.admission', causeKind: 'binding_missing',
            });
        }
        if (admittedDataQuery) {
            const scope = await readAdmittedDeploymentReadScopeInTx(tx, admittedDataQuery);
            if (!scope) return deploymentFailure('deployment_access_denied', {
                phase: 'deployment.secret_launch.data_role.scope', causeKind: 'not_found',
            });
            if ('databaseTarget' in admittedDataQuery) {
                const target = admittedDataQuery.databaseTarget, materialization = input.materialization;
                if (input.environmentId !== admittedDataQuery.environmentId || input.targetLinkId !== admittedDataQuery.targetLinkId) {
                    return deploymentFailure('deployment_access_denied', {
                        phase: 'deployment.secret_launch.data_role.operands', causeKind: 'access_denied',
                    });
                }
                if (target.kind === 'deployment_service' ? 'targetLinkId' in materialization
                    || materialization.deploymentId !== target.deploymentId || materialization.service !== target.serviceId
                    : !('targetLinkId' in materialization) || materialization.targetLinkId !== target.targetLinkId
                        || scope.managedControllerMachineId !== input.machineId) return deploymentFailure('deployment_access_denied', {
                    phase: 'deployment.secret_launch.data_role.operands', causeKind: 'access_denied',
                });
            } else if ('targetLinkId' in input.materialization) {
                return deploymentFailure('deployment_access_denied', {
                    phase: 'deployment.secret_launch.data_role.operands', causeKind: 'access_denied',
                });
            }
        }
        const loaded = await loadDeploymentEnvironmentCustodyInTx(tx, input);
        if (!loaded.ok) return loaded;
        return { ok: true, grants: await readEnvironmentMachineSecretGrantsInTx(tx, {
            environmentId: loaded.row.id, machineId: input.machineId, installationId: input.installationId,
        }) };
    }
    if (input.materialization.kind === 'bindings') return readEnvironmentBindingPreparationInTx(tx, actorAccountId,
        { serverId: input.serverId, environmentId: input.environmentId, expectedRevision: input.materialization.expectedRevision,
            domainIds: input.materialization.domainIds, dataRoleTargetLinkIds: input.materialization.dataRoleTargetLinkIds,
            targetLinkId: input.targetLinkId, ...(input.materialization.buildMachineId
                ? { buildMachineId: input.materialization.buildMachineId } : {}) }, authentication);
    if (input.materialization.kind === 'domain') {
        const domain = input.materialization;
        if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId
            || (domain.use && domain.use.domainId !== domain.domainId) || domain.capture.placement.serverId !== input.serverId
            || domain.capture.placement.environmentId !== input.environmentId
            || domain.capture.placement.targetLinkId !== input.targetLinkId) return deploymentFailure('deployment_access_denied');
        if (!domain.use) {
            return { ok: true, grants: [], domainAdmission };
        }
        const owner = await readAcceptedDeploymentDomainSecretDestinationInTx(tx, { environmentId: input.environmentId,
            domainId: domain.domainId, expectedDomainRevision: domain.expectedDomainRevision, actionOperationId: domain.actionOperationId,
            capture: domain.capture, machineId: input.machineId, installationId: input.installationId,
            installationPublicKey }, admittedChild?.domainJob);
        if (!owner) return deploymentFailure('deployment_access_denied');
        const ref = parseSavedSecretRefV1(domain.use.source.ref);
        if (ref.kind !== 'shared_resource') return { ok: false, error: 'secret_missing' };
        const grants = await readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: input.environmentId,
            machineId: input.machineId, installationId: input.installationId,
            secret: { resourceId: ref.resourceId, resourceRevision: domain.use.source.resourceRevision } });
        if (grants.length !== 1) return { ok: false, error: 'secret_missing' };
        return { ok: true, grants };
    }
    const copySourceRead = input.materialization.kind === 'copySourceRead';
    const admittedCopy = admittedBackup?.kind === 'restore'
        && admittedBackup.source.kind === 'repository' && !!admittedBackup.source.origin;
    if (copySourceRead && !admittedCopy) {
        return deploymentFailure('deployment_access_denied');
    }
    // Home has bound both copy scopes to the admitted source member. Destination
    // safety credentials use that custody without requiring destination placement.
    const loaded = admittedCopy ? await loadDeploymentEnvironmentCustodyInTx(tx, input)
        : input.materialization.kind === 'deployment'
        ? await loadDeploymentEnvironmentForInstalledMachineInTx(tx, input)
        : await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    const owner = 'owner' in loaded ? loaded.owner : loaded.admission.owner;
    // Review is a new request; an accepted deployment instead consumes its
    // installed admission and does not re-admit the original requester.
    if ('admission' in loaded && !canDeployDeploymentEnvironment(loaded.admission, loaded.row)) {
        return deploymentFailure('deployment_access_denied');
    }
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: input.targetLinkId, environmentId: loaded.row.id, deletedAt: null },
        include: { machines: { orderBy: { position: 'asc' } } } });
    if (!link || loaded.row.runtimeTargetLinkId !== link.id) {
        return deploymentFailure('deployment_access_denied');
    }
    const runtime = readDeploymentTargetRuntimeInstallations(link)
        .some(member => member.machineId === input.machineId && member.installationId === input.installationId);
    const receipt = input.materialization.kind === 'deployment' || input.materialization.kind === 'copySourceRead'
        ? await tx.deployment.findFirst({ where: { id: input.materialization.deploymentId, environmentId: loaded.row.id,
            targetLinkId: link.id, actionOperationId: input.materialization.actionOperationId } }) : null;
    if ((input.materialization.kind === 'deployment' || copySourceRead)
        && (!receipt || (copySourceRead ? receipt.id !== admittedBackup?.deploymentId : admittedBackup
            ? receipt.id !== link.activeDeploymentId || !['succeeded', 'running_unverified'].includes(receipt.state)
            : receipt.cancelRequestedAt || !['queued', 'running'].includes(receipt.state)))) return deploymentFailure('deployment_unavailable');
    const accepted = receipt ? readDeploymentAcceptedExecution(receipt) : null;
    if ((input.materialization.kind === 'deployment' || copySourceRead) && !accepted) return deploymentFailure('deployment_access_denied');
    const build = input.materialization.kind === 'deployment'
        ? accepted?.builder?.machineId === input.machineId && accepted.builder.installationId === input.installationId
        : loaded.row.buildMachineId === input.machineId;
    if (!admittedCopy && !runtime && !build) {
        return deploymentFailure('deployment_access_denied');
    }
    const machineFailure = 'owner' in loaded ? null : await admitDeploymentMachineInTx(tx, owner,
        input.machineId, runtime ? 'target' : 'build', input.installationId);
    if (machineFailure) return machineFailure;
    const grants = await readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: loaded.row.id,
        machineId: input.machineId, installationId: input.installationId });
    if (copySourceRead) {
        // Unknown routing stays incomplete; it cannot be guessed from possession of an installation seal.
        const backupCaptures = selectEnvironmentSecretCapturePurposesV1(loaded.row.referencedSavedSecretRevisions, ['backupDestination']);
        const required = projectEnvironmentSecretBindingRequiredUsesV1({ referencedSavedSecretRevisions: backupCaptures,
            runtimeInstallations: [{ machineId: input.machineId, installationId: input.installationId }] });
        if (required.status !== 'complete') return { ok: false, error: 'secret_missing' };
        const backupGrants = grants.filter(grant => grant.kind === 'secret' && required.requiredSecretUses.some(use =>
            grant.resourceId === use.resourceId && grant.resourceRevision === use.resourceRevision));
        if (backupGrants.length !== required.requiredSecretUses.length) return { ok: false, error: 'secret_missing' };
        return { ok: true, grants: backupGrants };
    }
    // Binding CAS records consent; the resource mutation owner prunes seals on
    // withdrawal or revision changes. Installed delivery consumes those rows.
    return { ok: true, grants };
}

/** Both preparing hosts consume the same current Environment principal, capability and installation decision. */
async function readEnvironmentBindingPreparationInTx(tx: Tx, actorAccountId: string,
    input: Readonly<{ serverId: string; environmentId: string; expectedRevision: number; targetLinkId?: string; buildMachineId?: string;
        domainIds?: readonly string[]; dataRoleTargetLinkIds?: readonly string[] }>,
    authentication: DeploymentAuthentication,
): Promise<EnvironmentSecretLaunchAdmissionResultV1> {
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (!projectDeploymentEnvironmentHeader(loaded.row, input.serverId, loaded.admission).capabilities.manageBindings) {
        return deploymentFailure('deployment_access_denied');
    }
    if (loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    if (input.targetLinkId !== undefined && input.targetLinkId !== loaded.row.runtimeTargetLinkId) return deploymentFailure('deployment_access_denied');
    const link = loaded.row.runtimeTargetLinkId ? await tx.deploymentTargetLink.findFirst({
        where: { id: loaded.row.runtimeTargetLinkId, environmentId: loaded.row.id, deletedAt: null },
        include: { machines: { orderBy: { position: 'asc' } } },
    }) : null;
    if (loaded.row.runtimeTargetLinkId && !link) return deploymentFailure('deployment_access_denied');
    const runtimeMachines = link ? readDeploymentTargetRuntimeInstallations(link) : [];
    const managedDataLinks = await readCurrentManagedDataTargetLinksInTx(tx, { environmentId: loaded.row.id,
        targetLinkIds: input.dataRoleTargetLinkIds ?? [] });
    if (managedDataLinks === null) return deploymentFailure('deployment_access_denied');
    const domainDestinations = await readDeploymentDomainOperationalDestinationsInTx(tx, {
        environmentId: loaded.row.id, domainIds: input.domainIds ?? [],
    });
    const recipients = [...runtimeMachines.map(member => ({ machineId: member.machineId,
        installationId: member.installationId, role: 'target' as const })),
        ...(loaded.row.buildMachineId ? [{ machineId: loaded.row.buildMachineId, role: 'build' as const }] : []),
        ...(input.buildMachineId ? [{ machineId: input.buildMachineId, role: 'build' as const }] : []),
        ...(managedDataLinks.length ? [{ machineId: loaded.row.controllerMachineId, role: 'controller' as const }] : []),
        ...domainDestinations.domains.flatMap(domain => domain.placements.map(placement => ({ machineId: placement.machineId,
            installationId: placement.installationId, role: 'target' as const })))];
    const denied = await admitDeploymentMachinesInTx(tx, loaded.admission.owner, recipients);
    if (denied) return denied;
    const keys = new Map<string, { machineId: string; installationId: string; publicKey: string }>();
    for (const ids of portableQueryChunks({ values: [...new Set(recipients.map(recipient => recipient.machineId))], bindingsPerValue: 1 })) {
        const rows = await tx.machine.findMany({ where: { id: { in: [...ids] } },
            select: { id: true, installationId: true, installationPublicKey: true } });
        for (const row of rows) {
            if (!row.installationId || !row.installationPublicKey) return deploymentFailure('deployment_access_denied');
            keys.set(row.id, { machineId: row.id, installationId: row.installationId,
                publicKey: Buffer.from(row.installationPublicKey).toString('base64url') });
        }
    }
    if (keys.size !== new Set(recipients.map(recipient => recipient.machineId)).size) return deploymentFailure('deployment_access_denied');
    if (domainDestinations.domains.some(domain => domain.placements.some(placement =>
        keys.get(placement.machineId)?.publicKey !== placement.installationPublicKey))) return deploymentFailure('deployment_access_denied');
    return EnvironmentSecretLaunchAdmissionResultV1Schema.parse({ ok: true,
        grants: await readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: loaded.row.id }),
        bindingPreparation: { runtimeInstallations: runtimeMachines.map(member => keys.get(member.machineId)),
            domainDestinations: { status: domainDestinations.status, domains: domainDestinations.domains.map(domain => ({
                domainId: domain.domainId, installations: domain.placements.map(placement => ({ machineId: placement.machineId,
                    installationId: placement.installationId, publicKey: placement.installationPublicKey })),
            })) },
            ...(loaded.row.buildMachineId ? { buildInstallation: keys.get(loaded.row.buildMachineId) } : {}),
            ...(input.buildMachineId ? { proposedBuildInstallation: keys.get(input.buildMachineId) } : {}),
            ...(managedDataLinks.length ? { controllerInstallation: keys.get(loaded.row.controllerMachineId) } : {}) } });
}

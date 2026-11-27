import { isDeploymentProductionPromotionPairV1 } from '@happier-dev/deployments/contracts/v1';
import type { z } from 'zod/mini';
import { DeploymentActionFailureV1Schema } from '@happier-dev/protocol';
import type { DeploymentMachinePlacementDiagnosticV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_MACHINE_INSTALLATION_REPLACED_REASON_V1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { DEPLOYMENT_MACHINE_REINSTALL_ACTION_IDS_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ProjectSourceV1, ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { resolveProjectSourceAccessInTx, type ProjectSourceAccess, type ProjectSourceAccessResult } from '@/app/projects/sources/projectSourceService';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveMachinePrincipalAccessForMachinesInTx, resolveMachineAdmissionsInTx } from '@/app/machines/machineAccess';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { Tx } from '@/storage/inTx';
import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { withActionFailureDiagnostic, type ActionFailureDiagnosticInput } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { log } from '@/utils/logging/log';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { deploymentEnvironmentPrincipalKeyV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';
import { readDeploymentEnvironmentPrincipals, type DeploymentEnvironmentPrincipalPurpose,
    type DeploymentEnvironmentPrincipalRow } from './deploymentEnvironmentDeployers';

type DeploymentActionFailure = z.infer<typeof DeploymentActionFailureV1Schema>;
// Shared resource admission never executes an unavailable native operation.
export type DeploymentFailure = DeploymentActionFailure & Readonly<{
    error: Exclude<DeploymentActionFailure['error'], 'unsupported_action'>;
}>;
export type DeploymentAuthentication = Partial<TeamOperationAuthenticationContext>;
/** Private diagnostics use one safe projector and sink without widening the public refusal. */
export function deploymentFailure<TError extends Extract<DeploymentActionFailure['error'], 'deployment_invalid' | 'deployment_unavailable' | 'deployment_access_denied' | 'deployment_conflict' | 'deployment_content_unavailable' | 'deployment_teardown_required' | 'machine_unavailable' | 'unsupported_action' | 'client_required'>>(
    error: TError, diagnostic?: ActionFailureDiagnosticInput,
): Readonly<{ ok: false; error: TError }> {
    const failure = { ok: false as const, error };
    return diagnostic ? withActionFailureDiagnostic(failure, diagnostic, safeDiagnostic => {
        // The secret-launch route records data-role diagnostics with its request identity.
        if (!diagnostic.phase.startsWith('deployment.secret_launch.data_role.')) {
            log({ module: 'deployments', errorCode: error, diagnostic: safeDiagnostic });
        }
    }) : failure;
}

/** One placement refusal shape: credential_scope_denied carrying the deciding owner's next Action. */
function projectDeploymentPlacementRefusal(details: Readonly<{ reason: string; requiredFact: string; remedy: string; machineId?: string; actionIds?: readonly string[] }>,
    phase: string): ActionExecuteFailure {
    const error = Object.assign(new Error('credential_scope_denied'), { code: 'credential_scope_denied' });
    return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', details,
        failureCause: projectActionFailureCauseV1(error, phase) };
}
/** The root ran on another Machine than the Environment's recorded controller; callers never select a replacement. */
export function projectDeploymentControllerPlacementFailure(controllerMachineId: string): ActionExecuteFailure {
    return projectDeploymentPlacementRefusal({ reason: 'controller_placement_mismatch', requiredFact: `controllerMachineId=${controllerMachineId}`,
        remedy: `Run this action on Machine ${controllerMachineId}, or make that controller reachable, then retry` }, 'deployment.controller.placement');
}
/** A runtime member recorded under a retired installation of a still-current Machine: the remedy is its reinstall Actions. */
export function projectDeploymentRuntimeInstallationReplacedFailure(member: Readonly<{ machineId: string; retiredInstallationId: string }>): ActionExecuteFailure {
    return projectDeploymentPlacementRefusal({ reason: DEPLOYMENT_MACHINE_INSTALLATION_REPLACED_REASON_V1,
        requiredFact: `installationId=${member.retiredInstallationId}`, machineId: member.machineId,
        remedy: 'This Machine was reinstalled. Keep this Environment: link its runtime target to the Machine\'s current installation, save its secrets again, then deploy.',
        actionIds: DEPLOYMENT_MACHINE_REINSTALL_ACTION_IDS_V1 },
    'deployment.runtime.machine_installation');
}
/** The Source owner principal cannot use the selected Machine (admitDeploymentMachinesInTx); other Machine failures stay bare. */
export function projectDeploymentSourceMachinePlacementFailure(failure: DeploymentFailure): ActionExecuteFailure | undefined {
    if (failure.error !== 'machine_unavailable' || failure.diagnostic?.reason !== 'source_machine_access_missing') return undefined;
    return projectDeploymentPlacementRefusal(failure.diagnostic, 'deployment.source.machine_placement');
}
export interface DeploymentSourceAdmission {
    readonly source: ProjectSourceV1;
    readonly owner: ProjectSourceOwnerV1;
    readonly canManage: boolean;
    readonly canDeployMember: boolean;
    readonly effectivePrincipals: readonly PrincipalRefV1[];
}

/** Deployment management belongs to the Source owner, independent of audience management grants. */
export function projectDeploymentSourceAdmission(read: ProjectSourceAccess): DeploymentSourceAdmission {
    return { source: read.source, owner: read.owner, canManage: read.canManageOwner, canDeployMember: read.canDeployMember,
        effectivePrincipals: read.effectivePrincipals };
}

/** The one selection rule shared by deployers and database editors: does the actor's live membership match a chosen principal? */
export function matchesDeploymentEnvironmentPrincipals(admission: DeploymentSourceAdmission,
    principals: readonly DeploymentEnvironmentPrincipalRow[] | undefined, purpose: DeploymentEnvironmentPrincipalPurpose,
): boolean {
    if (!principals) return false;
    const effective = new Set(admission.effectivePrincipals.map(deploymentEnvironmentPrincipalKeyV1));
    return readDeploymentEnvironmentPrincipals(principals, purpose).some(principal => effective.has(deploymentEnvironmentPrincipalKeyV1(principal)));
}

/** Who may act under one Environment people mode (shared by deployers and editors). */
function admitsDeploymentEnvironmentPeople(admission: DeploymentSourceAdmission, mode: string,
    principals: readonly DeploymentEnvironmentPrincipalRow[] | undefined, purpose: DeploymentEnvironmentPrincipalPurpose,
): boolean {
    return admission.canManage || (mode === 'members' && admission.canDeployMember)
        || (mode === 'chosen' && matchesDeploymentEnvironmentPrincipals(admission, principals, purpose));
}

/** Projection and new-effect admission share current Source authority and exact chosen relations. */
export function canDeployDeploymentEnvironment(admission: DeploymentSourceAdmission,
    environment: Readonly<{ deletedAt: Date | null; deployerMode: string; principals?: readonly DeploymentEnvironmentPrincipalRow[] }>,
): boolean {
    return !environment.deletedAt && admitsDeploymentEnvironmentPeople(admission, environment.deployerMode, environment.principals, 'deploy');
}

/** Production handoff is a deploy. Legacy promotion may also edit the destination definition. */
export function canPromoteToDeploymentEnvironment(
    source: Parameters<typeof isDeploymentProductionPromotionPairV1>[0],
    destination: Parameters<typeof isDeploymentProductionPromotionPairV1>[1] & Parameters<typeof canDeployDeploymentEnvironment>[1],
    admission: DeploymentSourceAdmission,
): boolean {
    return canDeployDeploymentEnvironment(admission, destination) && (destination.protection === 'production'
        ? isDeploymentProductionPromotionPairV1(source, destination)
        : source.id !== destination.id && admission.canManage);
}

/** Database editing (P3 M1): Off, or the same people choice and member predicate as deployers, over 'dataEdit' rows. */
export function canEditDeploymentEnvironmentData(admission: DeploymentSourceAdmission,
    environment: Readonly<{ deletedAt: Date | null; dataEditorMode: string; principals?: readonly DeploymentEnvironmentPrincipalRow[] }>,
): boolean {
    return !environment.deletedAt && environment.dataEditorMode !== 'off'
        && admitsDeploymentEnvironmentPeople(admission, environment.dataEditorMode, environment.principals, 'dataEdit');
}

/** Removed Environments retain resources that only their current Source manager may tear down. */
export function canTeardownDeploymentEnvironment(admission: DeploymentSourceAdmission,
    environment: Parameters<typeof canDeployDeploymentEnvironment>[1],
): boolean {
    return environment.deletedAt ? admission.canManage : canDeployDeploymentEnvironment(admission, environment);
}

/** The Source is the only workload authority, independent of creator and audience ordering. */
export async function resolveDeploymentEnvironmentAdmissionInTx(tx: Tx, actorAccountId: string,
    input: Readonly<{ serverId: string; projectSourceId: string; includeDeletedSource?: boolean }>, authentication: DeploymentAuthentication = {},
): Promise<Readonly<{ ok: true; admission: DeploymentSourceAdmission }> | DeploymentFailure> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable', { phase: 'deployment.source.admission.server', causeKind: 'server_mismatch' });
    // Existing Environments retain Source authority and identity after deletion.
    // New-Environment admission opts into the owner's active-only read instead.
    const read = await resolveProjectSourceAccessInTx(tx, actorAccountId, input.projectSourceId, authentication,
        { includeDeleted: input.includeDeletedSource !== false });
    return projectDeploymentSourceAdmissionRead(read);
}

export function projectDeploymentSourceAdmissionRead(read: ProjectSourceAccessResult | undefined):
    Readonly<{ ok: true; admission: DeploymentSourceAdmission }> | DeploymentFailure {
    if (!read?.ok) return deploymentFailure('deployment_unavailable', {
        phase: 'deployment.source.admission.read',
        causeKind: read?.failure.error === 'source_invalid' ? 'incomplete' : 'not_found',
    });
    return { ok: true, admission: projectDeploymentSourceAdmission(read) };
}

type DeploymentMachineRole = Extract<DeploymentFailure, { error: 'machine_unavailable' }>['role'];

/** Machine permission, revocation and replacement are decided by the current Machine owner. */
export async function admitDeploymentMachineInTx(tx: Tx, owner: ProjectSourceOwnerV1, machineId: string,
    role: DeploymentMachineRole, installationId?: string,
): Promise<DeploymentFailure | null> {
    const placement = await admitDeploymentMachinesInTx(tx, owner, [{ machineId, role, installationId }]);
    return placement.ok ? null : placement;
}

type DeploymentMachineInput = Readonly<{ machineId: string; installationId?: string; role?: DeploymentMachineRole }>;
const sourceMachineAccessMissing = { reason: 'source_machine_access_missing', requiredFact: 'source_machine_use',
    remedy: 'share_machine_with_source_owner' } as const satisfies DeploymentMachinePlacementDiagnosticV1;

/** The first failed placement role owns the recovery diagnostic. */
export function deploymentMachineUnavailable(machineId: string, role: DeploymentMachineRole): Extract<DeploymentFailure, { error: 'machine_unavailable' }> {
    return { ok: false, error: 'machine_unavailable', role, machineIds: [machineId],
        nextActions: role === 'target' ? ['start', 'removeFromEnvironment'] : ['start', 'chooseAnother'] };
}

function unavailableDeploymentMachines(inputs: readonly DeploymentMachineInput[],
    diagnostic?: DeploymentMachinePlacementDiagnosticV1, effectAttempted?: false,
): DeploymentFailure | null {
    const first = inputs[0];
    if (!first) return null;
    const role = first.role ?? 'target';
    return { ...deploymentMachineUnavailable(first.machineId, role),
        machineIds: inputs.filter(input => (input.role ?? 'target') === role).map(input => input.machineId),
        ...(effectAttempted !== undefined ? { effectAttempted } : {}), ...(diagnostic ? { diagnostic } : {}) };
}

/** A copy restore that does not run on a source member runs on the person's own Machine only. The source backup
 * credential is sealed for, and delivered to, that one current installation; a Machine another Account holds never
 * receives it. The seal writer, its key read and the restore mint consume this one decision. */
export async function admitDeploymentCopyRestoreRecipientInTx(tx: Tx, actorAccountId: string,
    recipient: Readonly<{ machineId: string; installationId: string }>,
): Promise<Readonly<{ ok: true; machineId: string; installationId: string; publicKey: Uint8Array }> | DeploymentFailure> {
    const machine = await tx.machine.findUnique({ where: { id: recipient.machineId }, select: { accountId: true,
        installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true } });
    if (!machine || machine.accountId !== actorAccountId || machine.revokedAt || machine.replacedByMachineId
        || machine.installationId !== recipient.installationId || !machine.installationPublicKey) {
        return deploymentFailure('deployment_access_denied', { phase: 'deployment.copy_restore.recipient', causeKind: 'access_denied' });
    }
    return { ok: true, machineId: recipient.machineId, installationId: recipient.installationId, publicKey: machine.installationPublicKey };
}

/** Definition writers require the person's actual Machine authority, not the Source's custody grant. */
export async function admitDeploymentDefinitionMachinesInTx(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1,
    inputs: readonly Readonly<{ machineId: string; installationId?: string; role?: 'controller' | 'build' | 'target' }>[],
): Promise<DeploymentFailure | null> {
    const custody = await resolveMachinePrincipalAccessForMachinesInTx(tx, { principal: owner, machineIds: inputs.map(input => input.machineId) });
    const custodyFailure = unavailableDeploymentMachines(inputs.filter(input => !custody.get(input.machineId)), sourceMachineAccessMissing, false);
    if (custodyFailure) return custodyFailure;
    const admissions = await resolveMachineAdmissionsInTx(tx, { actorAccountId, machineIds: inputs.map(input => input.machineId) });
    const failedMachines = inputs.filter(input => {
        const admission = admissions.get(input.machineId);
        return admission?.kind === 'denied' && admission.code === 'machine_unavailable'
            || admission?.kind === 'admitted' && input.installationId !== undefined && input.installationId !== admission.installationId;
    });
    const firstAdmission = failedMachines[0] ? admissions.get(failedMachines[0].machineId) : undefined;
    const machineFailure = unavailableDeploymentMachines(failedMachines,
        firstAdmission?.kind === 'denied' ? firstAdmission.diagnostic : undefined, false);
    if (machineFailure) return machineFailure;
    return inputs.some(input => {
        const admission = admissions.get(input.machineId);
        return admission?.kind !== 'admitted' || admission.role !== 'manage';
    }) ? deploymentFailure('deployment_access_denied') : null;
}

/** Existing placement needs Machine authority, not freshness of old execution captures (including retained predecessors). */
export async function readDeploymentDefinitionMachinesInTx(tx: Tx,
    environment: Readonly<{ id: string; controllerMachineId: string | null; buildMachineId: string | null; edgeMachineId: string | null }>,
): Promise<readonly Readonly<{ machineId: string; installationId?: string; role?: 'controller' | 'build' | 'target' }>[]> {
    const links = await tx.deploymentTargetLink.findMany({ where: { environmentId: environment.id, deletedAt: null, detachedAt: null },
        select: { machineId: true, machines: { select: { machineId: true } } } });
    return [
        ...(environment.controllerMachineId ? [{ machineId: environment.controllerMachineId, role: 'controller' as const }] : []),
        ...(environment.buildMachineId ? [{ machineId: environment.buildMachineId, role: 'build' as const }] : []),
        ...(environment.edgeMachineId ? [{ machineId: environment.edgeMachineId, role: 'target' as const }] : []),
        ...links.flatMap(link => [...link.machines,
            ...(link.machineId ? [{ machineId: link.machineId }] : [])]),
    ];
}

/** Receipt capture consumes the installations from the same read that admitted their placements. */
export async function admitDeploymentMachinesInTx(tx: Tx, owner: ProjectSourceOwnerV1,
    inputs: readonly Readonly<{ machineId: string; role: DeploymentMachineRole; installationId?: string }>[],
) {
    const machineIds = [...new Set(inputs.map(input => input.machineId))];
    const access = await resolveMachinePrincipalAccessForMachinesInTx(tx, { principal: owner, machineIds });
    const machines = new Map<string, Readonly<{ installationId: string | null; revokedAt: Date | null; replacedByMachineId: string | null }>>();
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1 })) {
        const rows = await tx.machine.findMany({ where: { id: { in: [...ids] } },
            select: { id: true, installationId: true, revokedAt: true, replacedByMachineId: true } });
        rows.forEach(row => machines.set(row.id, row));
    }
    const placements = new Map<string, Readonly<{ machineId: string; installationId: string }>>();
    const failed: DeploymentMachineInput[] = [];
    for (const input of inputs) {
        const machine = machines.get(input.machineId);
        if (!access.get(input.machineId) || !machine || machine.revokedAt
            || machine.replacedByMachineId || !machine.installationId
            || (input.installationId !== undefined && machine.installationId !== input.installationId)) {
            failed.push(input);
        } else {
            placements.set(input.machineId, { machineId: input.machineId, installationId: machine.installationId });
        }
    }
    const first = failed[0];
    return unavailableDeploymentMachines(failed,
        first && !access.get(first.machineId) ? sourceMachineAccessMissing : undefined)
        ?? { ok: true as const, placements };
}

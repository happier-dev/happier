import type { z } from 'zod/mini';
import { DeploymentActionFailureV1Schema } from '@happier-dev/protocol';
import type { ProjectSourceV1, ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { resolveProjectSourceAccessInTx, type ProjectSourceAccess } from '@/app/projects/sources/projectSourceService';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveMachinePrincipalAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { Tx } from '@/storage/inTx';

type DeploymentActionFailure = z.infer<typeof DeploymentActionFailureV1Schema>;
// Shared resource admission never executes an unavailable native operation.

export type DeploymentFailure = DeploymentActionFailure & Readonly<{
    error: Exclude<DeploymentActionFailure['error'], 'unsupported_action'>;
}>;

export type DeploymentAuthentication = Partial<TeamOperationAuthenticationContext>;

export const deploymentFailure = <TError extends Extract<DeploymentActionFailure['error'], 'deployment_invalid' | 'deployment_unavailable' | 'deployment_access_denied' | 'deployment_conflict' | 'deployment_content_unavailable' | 'unsupported_action' | 'client_required'>>(error: TError): Readonly<{ ok: false; error: TError }> => ({ ok: false, error });

export interface DeploymentSourceAdmission {
    readonly source: ProjectSourceV1;
    readonly owner: ProjectSourceOwnerV1;
    readonly canManage: boolean;
    readonly canDeployMember: boolean;
    readonly effectivePrincipals: readonly Readonly<{ principalKind: 'account' | 'teamGroup'; principalId: string }>[];
}

/** Deployment management belongs to the Source owner, independent of audience management grants. */

export function projectDeploymentSourceAdmission(read: ProjectSourceAccess): DeploymentSourceAdmission {
    return { source: read.source, owner: read.owner, canManage: read.canManageOwner, canDeployMember: read.canDeployMember,
        effectivePrincipals: read.effectivePrincipals.map(principal => principal.kind === 'account'
            ? { principalKind: 'account' as const, principalId: principal.accountId }
            : { principalKind: 'teamGroup' as const, principalId: principal.groupId }) };
}

/** Projection and new-effect admission share current Source authority and exact chosen relations. */

export function canDeployDeploymentEnvironment(admission: DeploymentSourceAdmission,
    environment: Readonly<{ deletedAt: Date | null; deployerMode: string; deployers?: readonly Readonly<{ principalKind: string; principalId: string }>[] }>,
): boolean {
    return !environment.deletedAt && (admission.canManage
        || (environment.deployerMode === 'members' && admission.canDeployMember)
        || (environment.deployerMode === 'chosen' && environment.deployers?.some(selected =>
            admission.effectivePrincipals.some(principal => principal.principalKind === selected.principalKind
                && principal.principalId === selected.principalId)) === true));
}

/** The Source is the only workload authority, independent of creator and audience ordering. */

export async function resolveDeploymentEnvironmentAdmissionInTx(tx: Tx, actorAccountId: string,
    input: Readonly<{ serverId: string; projectSourceId: string }>, authentication: DeploymentAuthentication = {},
): Promise<Readonly<{ ok: true; admission: DeploymentSourceAdmission }> | DeploymentFailure> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.serverId) return deploymentFailure('deployment_unavailable');
    const read = await resolveProjectSourceAccessInTx(tx, actorAccountId, input.projectSourceId, authentication);
    if (!read.ok) return deploymentFailure('deployment_unavailable');
    return { ok: true, admission: projectDeploymentSourceAdmission(read) };
}

/** Machine permission, revocation and replacement are decided by the current Machine owner. */

export async function admitDeploymentMachineInTx(tx: Tx, owner: ProjectSourceOwnerV1, machineId: string,
    role: 'controller' | 'build' | 'target', installationId?: string,
): Promise<DeploymentFailure | null> {
    return admitDeploymentMachinesInTx(tx, owner, [{ machineId, role, installationId }]);
}

/** Definition writers require the person's actual Machine authority, not the Source's custody grant. */

export async function admitDeploymentMachinesInTx(tx: Tx, owner: ProjectSourceOwnerV1,
    inputs: readonly Readonly<{ machineId: string; role: 'controller' | 'build' | 'target'; installationId?: string }>[],
): Promise<DeploymentFailure | null> {
    const machineIds = [...new Set(inputs.map(input => input.machineId))];
    const access = await resolveMachinePrincipalAccessForMachinesInTx(tx, { principal: owner, machineIds });
    const machines = new Map<string, Readonly<{ installationId: string | null; revokedAt: Date | null; replacedByMachineId: string | null }>>();
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1 })) {
        const rows = await tx.machine.findMany({ where: { id: { in: [...ids] } },
            select: { id: true, installationId: true, revokedAt: true, replacedByMachineId: true } });
        rows.forEach(row => machines.set(row.id, row));
    }
    const failed = inputs.filter(input => {
        const machine = machines.get(input.machineId);
        return !access.get(input.machineId) || !machine || machine.revokedAt
            || machine.replacedByMachineId || !machine.installationId
            || (input.installationId !== undefined && machine.installationId !== input.installationId);
    });
    const first = failed[0];
    return first ? { ok: false, error: 'machine_unavailable', role: first.role,
        machineIds: failed.filter(input => input.role === first.role).map(input => input.machineId),
        nextActions: first.role === 'target' ? ['start', 'removeFromEnvironment'] : ['start', 'chooseAnother'] } : null;
}

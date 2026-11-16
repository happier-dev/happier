import { deploymentEnvironmentPrincipalKeyV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { admitProjectSourcePrincipalSelectionInTx } from '@/app/projects/sources/projectSourcePrincipalAccess';
import type { DeploymentSourceAdmission } from './deploymentAdmission';

/** Which Environment selection a chosen principal row belongs to. */
export type DeploymentEnvironmentPrincipalPurpose = 'deploy' | 'dataEdit';

/** The stored shape of one chosen Environment principal (PrincipalRefV1 kinds, ids only). */
export interface DeploymentEnvironmentPrincipalRow {
    readonly purpose: string;
    readonly principalKind: string;
    readonly principalId: string;
    readonly principalTeamId: string | null;
}

/** Every Environment reader selects the same principal columns. */
export const deploymentEnvironmentPrincipalSelect = {
    select: { purpose: true, principalKind: true, principalId: true, principalTeamId: true },
} as const;

function readPrincipalRow(row: DeploymentEnvironmentPrincipalRow): PrincipalRefV1 {
    if (row.principalKind === 'account') return { kind: 'account', accountId: row.principalId };
    if (row.principalKind === 'team') return { kind: 'team', teamId: row.principalId };
    // The provider CHECK constraint guarantees a group row carries its Team.
    return { kind: 'group', teamId: row.principalTeamId!, groupId: row.principalId };
}

function writePrincipalRow(principal: PrincipalRefV1) {
    return principal.kind === 'account' ? { principalKind: 'account', principalId: principal.accountId, principalTeamId: null }
        : principal.kind === 'team' ? { principalKind: 'team', principalId: principal.teamId, principalTeamId: null }
            : { principalKind: 'group', principalId: principal.groupId, principalTeamId: principal.teamId };
}

/** The chosen principals of one selection, projected as PrincipalRefV1. */
export function readDeploymentEnvironmentPrincipals(rows: readonly DeploymentEnvironmentPrincipalRow[],
    purpose: DeploymentEnvironmentPrincipalPurpose,
): PrincipalRefV1[] {
    return rows.filter(row => row.purpose === purpose).map(readPrincipalRow);
}

/** Nested create rows for a new Environment's selections. */
export function createDeploymentEnvironmentPrincipalRows(actorAccountId: string,
    selections: Readonly<Partial<Record<DeploymentEnvironmentPrincipalPurpose, readonly PrincipalRefV1[]>>>,
) {
    return (Object.entries(selections) as [DeploymentEnvironmentPrincipalPurpose, readonly PrincipalRefV1[] | undefined][])
        .flatMap(([purpose, principals]) => (principals ?? []).map(principal =>
            ({ purpose, ...writePrincipalRow(principal), createdByAccountId: actorAccountId })));
}

/** Policy editing consumes the Source owner's live structural principal admission. */
export function admitDeploymentEnvironmentPrincipalsInTx(tx: Tx, admission: DeploymentSourceAdmission,
    principals: readonly PrincipalRefV1[],
): Promise<boolean> {
    return admitProjectSourcePrincipalSelectionInTx(tx, { owner: admission.owner, audience: admission.source.audience,
        accountIds: principals.flatMap(principal => principal.kind === 'account' ? [principal.accountId] : []),
        teamIds: principals.flatMap(principal => principal.kind === 'team' ? [principal.teamId] : []),
        groups: principals.flatMap(principal => principal.kind === 'group' ? [{ id: principal.groupId, teamId: principal.teamId }] : []) });
}

export function sameDeploymentEnvironmentPrincipals(previous: readonly DeploymentEnvironmentPrincipalRow[],
    purpose: DeploymentEnvironmentPrincipalPurpose, next: readonly PrincipalRefV1[],
): boolean {
    const keys = new Set(readDeploymentEnvironmentPrincipals(previous, purpose).map(deploymentEnvironmentPrincipalKeyV1));
    return keys.size === next.length && next.every(principal => keys.has(deploymentEnvironmentPrincipalKeyV1(principal)));
}

/** Apply one selection's relation delta inside the existing Environment CAS transaction, preserving retained attribution. */
export async function replaceDeploymentEnvironmentPrincipalsInTx(tx: Tx, environmentId: string, actorAccountId: string,
    purpose: DeploymentEnvironmentPrincipalPurpose,
    previousRows: readonly DeploymentEnvironmentPrincipalRow[],
    next: readonly PrincipalRefV1[],
): Promise<void> {
    const previous = readDeploymentEnvironmentPrincipals(previousRows, purpose);
    const previousKeys = new Set(previous.map(deploymentEnvironmentPrincipalKeyV1));
    const nextKeys = new Set(next.map(deploymentEnvironmentPrincipalKeyV1));
    const removed = previous.filter(principal => !nextKeys.has(deploymentEnvironmentPrincipalKeyV1(principal))).map(writePrincipalRow);
    for (const principals of portableQueryChunks({ values: removed, bindingsPerValue: 2, fixedBindings: 2 })) {
        await tx.deploymentEnvironmentDeployer.deleteMany({ where: { environmentId, purpose,
            OR: principals.map(({ principalKind, principalId }) => ({ principalKind, principalId })) } });
    }
    const added = next.filter(principal => !previousKeys.has(deploymentEnvironmentPrincipalKeyV1(principal)));
    for (const principals of portableQueryChunks({ values: added, bindingsPerValue: 6 })) {
        await tx.deploymentEnvironmentDeployer.createMany({ data: principals.map(principal =>
            ({ environmentId, purpose, ...writePrincipalRow(principal), createdByAccountId: actorAccountId })) });
    }
}

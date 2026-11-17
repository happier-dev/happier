import { automationSubjectKeyV1, type AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { readArtifactCandidateAccess, resolveArtifactAccessInTx } from '@/app/artifacts/artifactAccessService';
import { projectDeploymentSourceAdmission, type DeploymentAuthentication } from '@/app/deployments/deploymentAdmission';
import { loadDeploymentEnvironmentInTx, projectDeploymentEnvironmentHeader } from '@/app/deployments/deploymentEnvironmentService';
import { listMachineCandidatesInTx, resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { resolveProjectSourceAccessInTx } from '@/app/projects/sources/projectSourceService';
import { resolveProjectSourceQueryScopeInTx } from '@/app/projects/sources/projectSourceQuery';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import { resolveEffectiveSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { AutomationStoredContentReadError } from './automationStoredContentRead';

/** The trigger writer consumes one server decision; a caller header never grants reach. */
export async function resolveAutomationActionReachInTx(tx: Tx, input: Readonly<{
    accountId: string;
    authentication?: DeploymentAuthentication;
    definition: Readonly<{ mode: 'plain'; subject?: AutomationSubjectV1 }>
        | Readonly<{ mode: 'e2ee'; subjectKind?: string | null; subjectKey?: string | null;
            claimedReachesOthers?: boolean }>;
}>): Promise<boolean> {
    if (input.definition.mode === 'e2ee') {
        const { subjectKind, subjectKey } = input.definition;
        if (subjectKey && subjectKind === 'machine') {
            const serverId = await readCurrentServerIdentityId(process.env, tx);
            if (serverId) {
                const candidates = await listMachineCandidatesInTx(tx, input.accountId);
                const machineId = candidates.find(machineId => automationSubjectKeyV1({ kind: 'machine', serverId, machineId }) === subjectKey);
                if (machineId && await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.accountId, machineId }) === 'manage') return true;
            }
        }
        if (subjectKey && subjectKind === 'session' && input.authentication?.authenticationAuthority) {
            const serverId = await readCurrentServerIdentityId(process.env, tx);
            if (serverId) {
                const admitted = await resolveEffectiveSessionAccessWhere({ tx, mode: 'effective_access_v1',
                    accountId: input.accountId, capability: 'editSessionRecords', authentication: {
                        env: input.authentication.env ?? process.env, authority: input.authentication.authenticationAuthority,
                        authenticationEvidence: input.authentication.authenticationEvidence,
                    } });
                const sessions = await tx.session.findMany({ where: admitted.where, select: { id: true } });
                if (sessions.some(({ id: sessionId }) => automationSubjectKeyV1({ kind: 'session', serverId, sessionId }) === subjectKey)) return true;
            }
        }
        if (subjectKey && subjectKind === 'approvalProfile') {
            const serverId = await readCurrentServerIdentityId(process.env, tx);
            if (serverId) {
                const access = readArtifactCandidateAccess(input.accountId);
                const candidates = (await Promise.all([access.owned!, ...access.received].map(where =>
                    tx.artifact.findMany({ where, select: { id: true } })))).flat();
                const profile = candidates.find(({ id: profileId }) => automationSubjectKeyV1({ kind: 'approvalProfile', serverId, profileId }) === subjectKey);
                if (profile) {
                    const access = await resolveArtifactAccessInTx(tx, { actorAccountId: input.accountId, artifactId: profile.id });
                    if (access !== null && access.level !== 'view') return true;
                }
            }
        }
        if (subjectKey && subjectKind === 'app') {
            const serverId = await readCurrentServerIdentityId(process.env, tx);
            if (serverId) {
                const scope = await resolveProjectSourceQueryScopeInTx(tx, { actorAccountId: input.accountId,
                    authentication: input.authentication });
                if (scope.ok) {
                    const table = prismaRuntime.raw(getDbProviderFromEnv(process.env, 'postgres') === 'mysql' ? '`ProjectSource`' : '"ProjectSource"');
                    const candidates = await tx.$queryRaw<Readonly<{ id: string }>[]>(prismaRuntime.sql`SELECT s.id FROM ${table} s WHERE ${scope.where}`);
                    const source = candidates.find(({ id: projectSourceId }) => automationSubjectKeyV1({ kind: 'app', serverId, projectSourceId }) === subjectKey);
                    if (source) {
                        const access = await resolveProjectSourceAccessInTx(tx, input.accountId, source.id, input.authentication);
                        if (access.ok && access.canManage) return true;
                    }
                }
            }
        }
        if (subjectKey && (subjectKind === 'environment' || subjectKind === 'backup')) {
            const serverId = await readCurrentServerIdentityId(process.env, tx);
            if (serverId) {
                // Retained Environments keep Source-owner management after Source removal.
                const scope = await resolveProjectSourceQueryScopeInTx(tx, { actorAccountId: input.accountId,
                    authentication: input.authentication, includeDeleted: true });
                if (scope.ok) {
                    const mysql = getDbProviderFromEnv(process.env, 'postgres') === 'mysql';
                    const sources = prismaRuntime.raw(mysql ? '`ProjectSource`' : '"ProjectSource"');
                    const environments = prismaRuntime.raw(mysql ? '`DeploymentEnvironment`' : '"DeploymentEnvironment"');
                    const sourceId = prismaRuntime.raw(mysql ? 'e.`projectSourceId`' : 'e."projectSourceId"');
                    const deletedAt = prismaRuntime.raw(mysql ? 'e.`deletedAt`' : 'e."deletedAt"');
                    const candidates = await tx.$queryRaw<Readonly<{ id: string; projectSourceId: string }>[]>(prismaRuntime.sql`
                        SELECT e.id, ${sourceId} FROM ${environments} e JOIN ${sources} s ON s.id = ${sourceId}
                        WHERE ${scope.where} AND ${deletedAt} IS NULL`);
                    const environment = candidates.find(({ id: environmentId }) => automationSubjectKeyV1({ kind: subjectKind, serverId, environmentId }) === subjectKey);
                    if (environment) {
                        const access = await resolveProjectSourceAccessInTx(tx, input.accountId, environment.projectSourceId,
                            input.authentication, { includeDeleted: true });
                        if (access.ok && projectDeploymentSourceAdmission(access).canManage) return true;
                    }
                }
            }
        }
        // No server-owned full Database target census or saved-health management
        // binding exists here; finite restore operands do not supply such a census.
        // Unmatched private identities cannot acquire reach from a caller's claim.
        if (input.definition.claimedReachesOthers === true) throw new AutomationStoredContentReadError('contentInvalid');
        return false;
    }
    const subject = input.definition.subject;
    if (!subject) return false;
    switch (subject.kind) {
        case 'plugin':
        case 'project':
        case 'healthCheck':
            // Namespaced plugin and Account-private identities have no shared management grant.
            return false;
        case 'environment':
        case 'backup':
        case 'database': {
            // Private worktree/manual bindings do not establish a shared grant.
            if (subject.kind === 'database' && subject.target.kind !== 'environment') return false;
            const environmentId = subject.kind === 'database' ? subject.target.environmentId : subject.environmentId;
            const loaded = await loadDeploymentEnvironmentInTx(tx, input.accountId, subject.serverId,
                environmentId, input.authentication);
            return loaded.ok && projectDeploymentEnvironmentHeader(loaded.row, subject.serverId, loaded.admission).capabilities.manage;
        }
        case 'machine':
            if (await readCurrentServerIdentityId(process.env, tx) !== subject.serverId) return false;
            return await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.accountId,
                machineId: subject.machineId }) === 'manage';
        case 'app': {
            if (await readCurrentServerIdentityId(process.env, tx) !== subject.serverId) return false;
            const access = await resolveProjectSourceAccessInTx(tx, input.accountId,
                subject.projectSourceId, input.authentication);
            return access.ok && access.canManage;
        }
        case 'approvalProfile': {
            if (await readCurrentServerIdentityId(process.env, tx) !== subject.serverId) return false;
            const access = await resolveArtifactAccessInTx(tx, { actorAccountId: input.accountId,
                artifactId: subject.profileId });
            return access !== null && access.level !== 'view';
        }
        case 'session': {
            if (await readCurrentServerIdentityId(process.env, tx) !== subject.serverId) return false;
            const authentication = input.authentication;
            if (!authentication?.authenticationAuthority) return false;
            const access = await resolveSessionAccessForOperation(tx, { accountId: input.accountId,
                sessionId: subject.sessionId, capability: 'editSessionRecords', authentication: {
                    env: authentication.env ?? process.env, authority: authentication.authenticationAuthority,
                    authenticationEvidence: authentication.authenticationEvidence,
                } });
            return access.status === 'allowed';
        }
    }
}

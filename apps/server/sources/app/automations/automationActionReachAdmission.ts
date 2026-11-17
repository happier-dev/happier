import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { DeploymentAuthentication } from '@/app/deployments/deploymentAdmission';
import { loadDeploymentEnvironmentInTx, projectDeploymentEnvironmentHeader } from '@/app/deployments/deploymentEnvironmentService';
import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { resolveProjectSourceAccessInTx } from '@/app/projects/sources/projectSourceService';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import type { Tx } from '@/storage/inTx';
import { AutomationStoredContentReadError } from './automationStoredContentRead';

/** The trigger writer consumes one server decision; a caller header never grants reach. */
export async function resolveAutomationActionReachInTx(tx: Tx, input: Readonly<{
    accountId: string;
    authentication?: DeploymentAuthentication;
    definition: Readonly<{ mode: 'plain'; subject?: AutomationSubjectV1 }>
        | Readonly<{ mode: 'e2ee'; claimedReachesOthers?: boolean }>;
}>): Promise<boolean> {
    if (input.definition.mode === 'e2ee') {
        // An opaque selector digest currently has no server-verifiable management binding.
        if (input.definition.claimedReachesOthers === true) throw new AutomationStoredContentReadError('contentInvalid');
        return false;
    }
    const subject = input.definition.subject;
    if (!subject) return false;
    switch (subject.kind) {
        case 'plugin':
        case 'project':
        case 'healthCheck':
        case 'approvalProfile':
            // These live identities have no shared-with management producer yet.
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

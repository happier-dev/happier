import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DeploymentTargetRoleCommonInputV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginError } from '@happier-dev/cli-common/plugins/errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Shared credential-principal admission for deployment roles and partial-draft reads. */
export function admitDeploymentTargetCredentialPrincipalForHost(
    input: Pick<DeploymentTargetRoleCommonInputV1, 'credentialPrincipal' | 'credentialRef'>,
    credentialOwnerAccountId: string,
): DeploymentTargetRoleCommonInputV1['credentialPrincipal'] {
    const principal = input.credentialPrincipal;
    if (principal.kind === 'team') {
        if (principal.selection.deliveryMode !== 'direct') {
            throw Object.assign(new Error('deployment_target_role_unavailable'), { code: 'deployment_target_role_unavailable' });
        }
        if (!sameStrictJsonValue(principal.selection.disclosedMember, input.credentialRef)) {
            throw new PluginError({ code: 'deployment_access_denied', failureCause: projectActionFailureCauseV1(
                new Error('deployment_access_denied'), 'deployment.target.admission.credential_principal') });
        }
        return principal;
    }
    if (principal.accountId !== credentialOwnerAccountId
        || (principal.target.kind === 'account' ? !sameStrictJsonValue(principal.target.account, input.credentialRef)
            : !sameStrictJsonValue(principal.target.service, input.credentialRef.service))) {
        throw new PluginError({ code: 'deployment_access_denied', failureCause: projectActionFailureCauseV1(
            new Error('deployment_access_denied'), 'deployment.target.admission.credential_principal') });
    }
    return principal;
}

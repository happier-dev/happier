import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DeploymentTargetRoleCommonInputV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginError } from '@happier-dev/cli-common/plugins/errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Shared Account custody admission for deployment roles and partial-draft reads. */
export function admitDeploymentTargetCredentialPrincipalForHost(
    input: Pick<DeploymentTargetRoleCommonInputV1, 'credentialPrincipal' | 'credentialRef'>,
    credentialOwnerAccountId: string,
): Extract<DeploymentTargetRoleCommonInputV1['credentialPrincipal'], { kind: 'account' }> {
    const principal = input.credentialPrincipal;
    // Direct Team materialization remains with Providers. Logical Account
    // groups continue through the incumbent purpose-binding owner.
    if (principal.kind !== 'account') {
        throw Object.assign(new Error('deployment_target_role_unavailable'), { code: 'deployment_target_role_unavailable' });
    }
    if (principal.accountId !== credentialOwnerAccountId
        || (principal.target.kind === 'account' ? !sameStrictJsonValue(principal.target.account, input.credentialRef)
            : !sameStrictJsonValue(principal.target.service, input.credentialRef.service))) {
        throw new PluginError({ code: 'deployment_access_denied', failureCause: projectActionFailureCauseV1(
            new Error('deployment_access_denied'), 'deployment.target.admission.credential_principal') });
    }
    return principal;
}

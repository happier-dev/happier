import type { FastifyRequest } from 'fastify';
import type { ExternalActionServerPrincipalV1, ExternalActionExecutionAuthorizationBindingV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { SignedRootActionIdSchema, getActionSpec, isPluginProvenanceOnlyActionId } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveCredentialActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { isOriginalAccountExecutionAction, isOriginalTerminalExecutionAction, readExternalActionSessionProposalSurface } from '@/app/auth/externalActionExecutionAuthorization';

export function readExternalActionRequestPrincipal(
    request: FastifyRequest,
    actionId: string,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>
        & Readonly<{ envelope?: ExternalActionRequestEnvelope }>,
): ExternalActionServerPrincipalV1 | 'present_user_required' | null {
    const pluginInvocation = origin?.envelope?.pluginInvocation;
    // This claim only narrows an original Account root. The signed envelope
    // digest retains it; the exact receiving daemon derives plugin authority.
    if ((pluginInvocation || isPluginProvenanceOnlyActionId(actionId))
        && (request.authTokenKind !== 'account' || origin?.sessionActionOrigin || origin?.workflowActionOrigin)) return null;
    if (isPluginProvenanceOnlyActionId(actionId)
        && (!pluginInvocation || origin?.envelope?.target?.kind !== 'machine')) return null;
    // The authenticator has already verified the signature and current epoch.
    // Legacy paired credentials may propose only through the installed Session
    // proof below; they never acquire original headless execution authority.
    const credentialProvenanceAvailable = request.authTokenLegacy === false
        || request.authTokenLegacy === true && readExternalActionSessionProposalSurface(origin) !== undefined;
    const signedRootAction = SignedRootActionIdSchema.safeParse(actionId);
    if ((request.authTokenKind === 'terminal' || request.authTokenKind === 'account') && credentialProvenanceAvailable
        && request.authTokenEpoch !== undefined && signedRootAction.success
        && (request.authAuthority === 'account_automation' || request.authAuthority === 'present_user')) {
        const admission = resolveCredentialActionAdmissionV1({ spec: getActionSpec(signedRootAction.data),
            authority: request.authTokenKind === 'terminal' || request.authTokenLegacy === true
                ? 'account_automation' : request.authAuthority,
            grant: null, surface: readExternalActionSessionProposalSurface(origin) });
        // Authentication succeeded; preserve the policy owner's refusal before
        // placement eligibility combines it with other provenance requirements.
        if (!admission.ok) return admission.errorCode;
    }
    if (request.authTokenKind === 'terminal' && (request.authAuthority === 'account_automation' || request.authAuthority === 'present_user')
        && credentialProvenanceAvailable && request.authTokenEpoch !== undefined && signedRootAction.success
        && isOriginalTerminalExecutionAction(actionId, origin)) {
        // Managed FIN issuance still requires its installed source proof below;
        // this is credential authentication, not a native Action admission.
        // Current terminal policy may allow human local operations, but this
        // unattended signed continuation retains the token's automation floor.
        return { accountId: request.userId, authority: 'account_automation', authentication: {
            kind: 'terminal', tokenEpoch: request.authTokenEpoch,
            ...(request.authTokenAuthenticationEvidence ? { evidence: [...request.authTokenAuthenticationEvidence] } : {}),
        } };
    }
    if (request.authTokenKind === 'account'
        && (request.authAuthority === 'present_user' || request.authAuthority === 'account_automation')
        && credentialProvenanceAvailable && request.authTokenEpoch !== undefined
        && signedRootAction.success
        && isOriginalAccountExecutionAction(actionId, origin)) {
        return { accountId: request.userId, authority: request.authTokenLegacy === true ? 'account_automation' : request.authAuthority, authentication: {
            kind: 'account', tokenEpoch: request.authTokenEpoch,
            ...(request.authTokenAuthenticationEvidence ? { evidence: [...request.authTokenAuthenticationEvidence] } : {}),
        } };
    }
    const verified = request.apiTokenPrincipal;
    if (
        request.authTokenKind !== "api_token"
        || request.authAuthority !== "account_automation"
        || !verified
        || verified.authority !== "account_automation"
        || verified.accountId !== request.userId
    ) {
        return null;
    }
    return {
        accountId: verified.accountId,
        principalId: verified.principalId,
        credentialId: verified.credentialId,
        grant: verified.grant,
        authority: verified.authority,
    };
}


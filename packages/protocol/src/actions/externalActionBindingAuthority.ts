export type ExternalActionBindingAuthorityV1 = 'account_automation' | 'present_user';

export type ExternalActionBindingAuthorityProjectionV1 = Readonly<{
  authentication?: Readonly<{ kind: 'account' | 'terminal' }>;
  sessionActionOrigin?: unknown;
  workflowActionOrigin?: unknown;
  nativeCredentialSpawnChild?: unknown;
}>;

/** Project the signed root's authority floor without importing runtime owners. */
export function readExternalActionBindingAuthority(
  binding: ExternalActionBindingAuthorityProjectionV1,
  accountAuthority: ExternalActionBindingAuthorityV1 = 'present_user',
): ExternalActionBindingAuthorityV1 {
  return !binding.authentication || binding.sessionActionOrigin || binding.workflowActionOrigin
    || binding.nativeCredentialSpawnChild || binding.authentication.kind === 'terminal'
    ? 'account_automation' : accountAuthority;
}

/**
 * The one reviewer rule for a fresh `approval.request.decide` root: a present
 * person, or an explicit scoped API credential. Terminal and automation
 * provenance never approve; Home's route policy and hosts that must not record
 * consent they cannot spend both consume this rule.
 */
export function isApprovalDecisionReviewerBindingV1(binding: ExternalActionBindingAuthorityProjectionV1 & Readonly<{
  principalId?: string; credentialId?: string; grant?: unknown;
}>): boolean {
  return readExternalActionBindingAuthority(binding) === 'present_user'
    || Boolean(binding.principalId && binding.credentialId && binding.grant);
}

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

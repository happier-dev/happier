import type { AccountVoiceCredentialStatus } from './accountVoiceCredential';

/** A person's own selected Saved Secret is already approved by linking it. */
export function projectVoiceCredentialAccessReviewRequirement(
  credential: AccountVoiceCredentialStatus,
): 'linked' | 'approval_required' {
  return credential.savedSecret?.entry?.relationship === 'owner' ? 'linked' : 'approval_required';
}

import type { DeepSecReviewMode } from './command.js';

export const DEEPSEC_REVIEW_PROFILE_ID = 'happier.review.deepsec/review';
export const DEEPSEC_SECURITY_AUDIT_PROFILE_ID = 'happier.review.deepsec/repository-security-audit';

export function resolveDeepSecProfileMode(profileId: string | null | undefined): DeepSecReviewMode {
  return profileId === DEEPSEC_SECURITY_AUDIT_PROFILE_ID
    ? 'repository_security_audit'
    : 'current_diff';
}

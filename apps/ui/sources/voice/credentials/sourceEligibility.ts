/**
 * Voice keeps its historical import path while Connected Accounts owns the
 * shared eligibility contract used by every purpose-target chooser.
 */
export {
  resolveConnectedAccountPurposeTargetEligibility as resolveVoiceConnectedAccountTargetEligibility,
  type ConnectedAccountPurposeTargetEligibility as VoiceConnectedAccountTargetEligibility,
} from '@/sync/domains/connectedServices/connectedAccountPurposeTargetEligibility';

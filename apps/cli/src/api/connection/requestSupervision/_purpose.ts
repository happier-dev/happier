export type RequestPurpose =
  | 'probe'
  | 'durable_write'
  | 'recovery_read'
  | 'transcript_sync'
  | 'ephemeral_update'
  | 'snapshot_fetch';

export interface PurposeGatingPolicy {
  requireOnline: boolean;
  requireAuth: boolean;
  /** Which request outcomes are allowed to change connection-wide health. */
  outcomeSupervision: 'connection_health' | 'authentication_only';
}

export function gatingPolicyForPurpose(purpose: RequestPurpose): PurposeGatingPolicy {
  switch (purpose) {
    case 'probe':
      return { requireOnline: false, requireAuth: false, outcomeSupervision: 'connection_health' };
    case 'durable_write':
      return { requireOnline: false, requireAuth: true, outcomeSupervision: 'authentication_only' };
    case 'recovery_read':
      return { requireOnline: true, requireAuth: true, outcomeSupervision: 'authentication_only' };
    case 'transcript_sync':
      return { requireOnline: false, requireAuth: true, outcomeSupervision: 'authentication_only' };
    case 'ephemeral_update':
      return { requireOnline: false, requireAuth: true, outcomeSupervision: 'authentication_only' };
    case 'snapshot_fetch':
      return { requireOnline: false, requireAuth: true, outcomeSupervision: 'authentication_only' };
  }
}

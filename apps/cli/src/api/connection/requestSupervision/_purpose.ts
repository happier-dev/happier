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
}

export function gatingPolicyForPurpose(purpose: RequestPurpose): PurposeGatingPolicy {
  switch (purpose) {
    case 'probe':
      return { requireOnline: false, requireAuth: false };
    case 'durable_write':
      return { requireOnline: false, requireAuth: true };
    case 'recovery_read':
      return { requireOnline: true, requireAuth: true };
    case 'transcript_sync':
      return { requireOnline: false, requireAuth: true };
    case 'ephemeral_update':
      return { requireOnline: false, requireAuth: true };
    case 'snapshot_fetch':
      return { requireOnline: false, requireAuth: true };
  }
}

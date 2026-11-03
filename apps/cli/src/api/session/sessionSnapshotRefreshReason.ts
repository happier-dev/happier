export type SessionSnapshotRefreshReason =
  | 'connect'
  | 'reconnect'
  | 'waitForMetadataUpdate'
  | 'primaryTurnRuntimeState'
  | 'degraded-socket'
  | 'explicit-drain'
  | 'startup-drain'
  | 'manual-recovery'
  | 'legacy-compat-proof'
  | 'follow-occurrence'
  | 'follow-source-hydration'
  | 'requester-binding'
  | 'memory-change'
  | 'close-end-proof'
  | 'session-query'
  | 'session-control'
  | 'session-replay'
  | 'session-action'
  | 'session-notification'
  | 'session-content'
  | 'usage-query';

const PURPOSE_BY_REASON: Record<SessionSnapshotRefreshReason, string> = {
  connect: 'session-detail:socket-connect-catchup',
  reconnect: 'session-detail:socket-reconnect-catchup',
  waitForMetadataUpdate: 'session-detail:metadata-wait-catchup',
  primaryTurnRuntimeState: 'session-detail:primary-turn-runtime-state',
  'degraded-socket': 'session-detail:degraded-socket-repair',
  'explicit-drain': 'session-detail:explicit-drain',
  'startup-drain': 'session-detail:startup-drain',
  'manual-recovery': 'session-detail:manual-recovery',
  'legacy-compat-proof': 'session-detail:legacy-compat-proof',
  'follow-occurrence': 'session-detail:follow-occurrence',
  'follow-source-hydration': 'session-detail:follow-source-hydration',
  'requester-binding': 'session-detail:requester-binding',
  'memory-change': 'session-detail:memory-change',
  'close-end-proof': 'session-detail:close-end-proof',
  'session-query': 'session-detail:session-query',
  'session-control': 'session-detail:session-control',
  'session-replay': 'session-detail:session-replay',
  'session-action': 'session-detail:session-action',
  'session-notification': 'session-detail:session-notification',
  'session-content': 'session-detail:session-content',
  'usage-query': 'session-detail:usage-query',
};

export function resolveSessionSnapshotRequestPurpose(reason: SessionSnapshotRefreshReason): string {
  return PURPOSE_BY_REASON[reason];
}

/** Naming previously unclassified callers must not split their existing in-flight reads. */
export function resolveSessionSnapshotRequestCoalescingReason(reason: SessionSnapshotRefreshReason): SessionSnapshotRefreshReason {
  switch (reason) {
    case 'follow-occurrence':
    case 'follow-source-hydration':
    case 'memory-change':
    case 'close-end-proof':
    case 'session-query':
    case 'session-control':
    case 'session-replay':
    case 'session-action':
    case 'session-notification':
    case 'session-content':
    case 'usage-query':
      return 'legacy-compat-proof';
    default:
      return reason;
  }
}

export type SessionSnapshotRefreshReason =
  | 'connect'
  | 'reconnect'
  | 'waitForMetadataUpdate'
  | 'primaryTurnRuntimeState'
  | 'degraded-socket'
  | 'explicit-drain'
  | 'startup-drain'
  | 'manual-recovery'
  | 'legacy-compat-proof';

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
};

export function resolveSessionSnapshotRequestPurpose(reason: SessionSnapshotRefreshReason | undefined): string {
  return PURPOSE_BY_REASON[reason ?? 'legacy-compat-proof'];
}

import { processIdentityMatches } from '@happier-dev/cli-common/processInstance';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { readTerminalAttachmentInfo, readTerminalHostAttachmentState, terminalMetadataMatchesHostHandle } from '@/terminal/attachment/terminalAttachmentInfo';
import { windowsHostedAttachmentMatchesRunner } from '../platform/windows/windowsHostedSessionRuntime';
import { findSessionMarkerTrackingKey, readSessionMarker } from '../sessionRegistry';
import { isCanonicalSpawnSessionId } from '../sessions/isCanonicalSpawnSessionId';
import { resolveTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';
import type { SessionRunnerServiceabilityProbe } from '../sessions/isSessionRunnerActive';
import type { TrackedSession } from '../types';

/** The marker the runner holds for this Session, addressed by its tracking key. */
async function readRunnerSessionMarker(pid: number, sessionId: string) {
  const trackingKey = await findSessionMarkerTrackingKey({ pid, sessionId });
  return trackingKey ? readSessionMarker(trackingKey) : null;
}

export type RecoveredSpawnNonceAdmissionResult =
  | Readonly<{ type: 'not_found' }>
  | Readonly<{ type: 'pending' }>
  | (Extract<SpawnSessionResult, { type: 'success' }> & Readonly<{ sessionId: string }>)
  | Extract<SpawnSessionResult, { type: 'error' }>;

export async function resolveRecoveredSpawnNonceAdmission(input: Readonly<{
  spawnNonce: string;
  happyHomeDir: string;
  getChildren: () => readonly TrackedSession[];
  probeSessionServiceability: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
}>): Promise<RecoveredSpawnNonceAdmissionResult> {
  const nonce = input.spawnNonce.trim();
  const tracked = input.getChildren().find(child => child.spawnOptions?.spawnNonce?.trim() === nonce);
  if (!nonce || !tracked) return { type: 'not_found' };
  const sessionId = tracked.happySessionId?.trim();
  const processIdentity = resolveTrackedSessionRunnerIdentity(tracked);
  if (!processIdentity) return { type: 'pending' };
  const runnerPid = processIdentity.pid;
  const initialTerminal = tracked.hostedTerminal ?? tracked.happySessionMetadataFromLocalWebhook?.terminal;
  // Metadata is schema-owned JSON. Keep the original launch facts across OS/RPC awaits.
  const terminal = initialTerminal ? structuredClone(initialTerminal) : undefined;
  const requestedMode = tracked.spawnOptions?.terminal?.mode;
  const expectedId = terminal?.controlServiceabilityV1?.attachmentId
    ?? tracked.publishedTerminalControlServiceabilityAttachmentId;
  const stillAdmissible = () => {
    const currentIdentity = resolveTrackedSessionRunnerIdentity(tracked);
    return Boolean(currentIdentity && input.getChildren().includes(tracked)
      && tracked.happySessionId?.trim() === sessionId
      && tracked.spawnOptions?.spawnNonce?.trim() === nonce
      && tracked.spawnOptions?.terminal?.mode === requestedMode
      && processIdentityMatches(processIdentity, currentIdentity)
      && !tracked.startupCustody && !tracked.spawnStartupReadinessFailure
      && !tracked.reportMarkerCustody?.retiring
      && tracked.stopRequestedAtMs === undefined
      && tracked.sessionWebhookTimedOutAtMs === undefined);
  };
  if (!isCanonicalSpawnSessionId(sessionId) || !stillAdmissible()) return { type: 'pending' };
  const marker = await readRunnerSessionMarker(runnerPid, sessionId);
  if (!marker || marker.startedBy !== 'daemon' || marker.happySessionId !== sessionId
    || marker.respawn?.spawnNonce?.trim() !== nonce
    || !processIdentityMatches(processIdentity, marker)
    || !stillAdmissible()) return { type: 'pending' };
  if (terminal?.controlServiceabilityV1?.retired === true) return { type: 'pending' };
  const mode = terminal?.mode ?? requestedMode ?? marker.respawn?.terminal?.mode;
  const readAttachmentProof = async (): Promise<Readonly<{ attachmentId?: string }> | null> => {
    const attachment = await readTerminalHostAttachmentState({ happyHomeDir: input.happyHomeDir, sessionId });
    const currentTerminal = tracked.hostedTerminal ?? tracked.happySessionMetadataFromLocalWebhook?.terminal;
    if (attachment.status === 'unreadable' || currentTerminal?.controlServiceabilityV1?.retired === true) return null;
    if ((currentTerminal?.mode ?? requestedMode ?? marker.respawn?.terminal?.mode) !== mode) return null;
    if ((mode === 'windows_console' || mode === 'windows_terminal') && attachment.status === 'absent') {
      // Windows startup commits display metadata, not a terminal-host handle.
      const displayAttachment = await readTerminalAttachmentInfo({ happyHomeDir: input.happyHomeDir, sessionId });
      if (!displayAttachment || !windowsHostedAttachmentMatchesRunner({
        expected: terminal, actual: displayAttachment.terminal, runnerPid,
      }) || !windowsHostedAttachmentMatchesRunner({
        expected: tracked.hostedTerminal ?? tracked.happySessionMetadataFromLocalWebhook?.terminal,
        actual: displayAttachment.terminal, runnerPid,
      })) return null;
    } else if (mode !== 'plain') {
      if (attachment.status !== 'present' || attachment.info.version === 1) return null;
      const currentId = currentTerminal?.controlServiceabilityV1?.attachmentId
        ?? tracked.publishedTerminalControlServiceabilityAttachmentId;
      if (!terminal || !currentTerminal
        || !terminalMetadataMatchesHostHandle(terminal, attachment.info.handle, expectedId)
        || !terminalMetadataMatchesHostHandle(currentTerminal, attachment.info.handle, currentId)) return null;
      if ((expectedId && attachment.info.attachmentId !== expectedId)
        || (currentId && attachment.info.attachmentId !== currentId)) return null;
      return { attachmentId: attachment.info.attachmentId };
    }
    return {};
  };
  const initialAttachment = await readAttachmentProof();
  if (!initialAttachment || !stillAdmissible()) return { type: 'pending' };
  const probe = await input.probeSessionServiceability(sessionId);
  if (probe.state !== 'runner_present' || probe.control.state !== 'servable' || !stillAdmissible()) {
    return { type: 'pending' };
  }
  const currentMarker = await readRunnerSessionMarker(runnerPid, sessionId);
  if (!currentMarker || currentMarker.startedBy !== 'daemon' || currentMarker.happySessionId !== sessionId
    || currentMarker.respawn?.spawnNonce?.trim() !== nonce
    || !processIdentityMatches(processIdentity, currentMarker)
    || currentMarker.respawn?.terminal?.mode !== marker.respawn?.terminal?.mode
    || !stillAdmissible()) return { type: 'pending' };
  const currentAttachment = await readAttachmentProof();
  if (!currentAttachment || currentAttachment.attachmentId !== initialAttachment.attachmentId) return { type: 'pending' };
  return stillAdmissible()
    ? { type: 'success', sessionId, ...(tracked.sessionCreationOutcome ? { sessionCreationOutcome: tracked.sessionCreationOutcome } : {}) }
    : { type: 'pending' };
}

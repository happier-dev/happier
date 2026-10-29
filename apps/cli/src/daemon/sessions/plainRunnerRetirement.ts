import { isPidProvablyAbsent } from '@happier-dev/cli-common/process';
import { SessionTerminalMetadataSchema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { retireSessionRunnerMetadata } from '@/session/metadata/sessionRunnerMetadata';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { clearTerminalControlServiceabilityProjection } from '../startup/terminalControlServiceabilityProjection';
import type { TrackedSession } from '../types';

/** A retired plain projection is process absence, never an attachment's retirement. */
export function readRetiredPlainRunnerObservation(metadata: Readonly<Record<string, unknown>>): number | null {
  if (metadata.hostPid !== undefined || metadata.hostProcessStartTimeMs !== undefined) return null;
  const terminal = SessionTerminalMetadataSchema.safeParse(metadata.terminal);
  if (!terminal.success || terminal.data.mode !== 'plain') return null;
  const proof = terminal.data.controlServiceabilityV1;
  return proof?.retired === true && proof.attachmentId === undefined && Number.isFinite(proof.observedAt)
    ? proof.observedAt : null;
}

/** Called only by confirmed exit tracking, not a runner's pre-exit startup unwind. */
export async function retireObservedSessionRunnerMetadata(params: Readonly<{
  metadata: Record<string, unknown>;
  expectedRunner: Readonly<{ pid: number; startTimeMs: number }>;
  trackedSession: TrackedSession;
  sessionId: string;
  happyHomeDir: string;
}>): Promise<Record<string, unknown>> {
  const retired = retireSessionRunnerMetadata(params.metadata, params.expectedRunner);
  if (retired === params.metadata) return retired;
  const tracked = params.trackedSession;
  if (typeof tracked.tmuxSessionId === 'string'
    || tracked.hostedTerminal?.mode !== undefined && tracked.hostedTerminal.mode !== 'plain'
    || tracked.spawnOptions?.terminal?.mode !== undefined && tracked.spawnOptions.terminal.mode !== 'plain') return retired;
  const terminal = SessionTerminalMetadataSchema.safeParse(params.metadata.terminal);
  if (params.metadata.terminal !== undefined && (!terminal.success || terminal.data.mode !== 'plain')) return retired;
  if (!isPidProvablyAbsent(params.expectedRunner.pid)) return retired;
  const attachment = await readTerminalHostAttachmentState({
    happyHomeDir: params.happyHomeDir, sessionId: params.sessionId,
  });
  if (attachment.status !== 'absent') return retired;
  // Keep the existing process-tuple retirement contract. Its durable plain
  // absence projection lets a later Stop prove topology without reviving a PID.
  return clearTerminalControlServiceabilityProjection({ metadata: retired,
    retiredAt: Date.now(), terminalMode: 'plain' });
}

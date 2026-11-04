import type { MachineSessionTerminalCaptureResponseV1 } from '@happier-dev/protocol';
import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';

/** These refusals cannot gain terminal authority by repeating the same exit. */
export function isSessionTerminalPermanentlyUnavailable(
  reason: Extract<MachineSessionTerminalCaptureResponseV1, { status: 'rejected' }>['reason'],
): boolean {
  return reason === 'archived' || reason === 'not_found' || reason === 'unsupported';
}

export async function settleFinalExitPublisher(params: Readonly<{
  apiMachine: Pick<ApiMachineClient, 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal'>;
  sessionId: string;
}>): Promise<'settled' | 'unavailable' | 'pending'> {
  try {
    const captureStartedAtMs = Date.now();
    const captured = await params.apiMachine.captureMachineSessionTerminal(params.sessionId);
    logger.infoFile('[DAEMON STOP] Final-exit terminal capture completed', {
      sessionId: params.sessionId, status: captured.status, elapsedMs: Date.now() - captureStartedAtMs,
    });
    if (captured.status === 'rejected') {
      if (isSessionTerminalPermanentlyUnavailable(captured.reason)) {
        logger.infoFile('[DAEMON RUN] Final-exit Session terminal authority permanently unavailable; completing local cleanup', {
          sessionId: params.sessionId, reason: captured.reason,
        });
        return 'unavailable';
      }
      logger.warn('[DAEMON RUN] Failed to capture final-exit Session terminal authority; retaining marker evidence', {
        sessionId: params.sessionId,
        reason: captured.reason,
      });
      return 'pending';
    }
    if (captured.status === 'already_inactive') return 'settled';

    const finalizeStartedAtMs = Date.now();
    const finalized = await params.apiMachine.finalizeMachineSessionTerminal({
      sessionId: captured.sessionId,
      authority: captured.authority,
    });
    logger.infoFile('[DAEMON STOP] Final-exit terminal finalization completed', {
      sessionId: params.sessionId, status: finalized.status, elapsedMs: Date.now() - finalizeStartedAtMs,
    });
    if (finalized.status !== 'rejected') return 'settled';
    if (isSessionTerminalPermanentlyUnavailable(finalized.reason)) {
      logger.infoFile('[DAEMON RUN] Final-exit Session terminal authority permanently unavailable; completing local cleanup', {
        sessionId: params.sessionId, reason: finalized.reason,
      });
      return 'unavailable';
    }
    logger.warn('[DAEMON RUN] Failed to finalize final-exit Session terminal authority; retaining marker evidence', {
      sessionId: params.sessionId,
      reason: finalized.reason,
    });
    return 'pending';
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to settle final-exit Session terminal authority; retaining marker evidence', {
      sessionId: params.sessionId,
      error,
    });
    return 'pending';
  }
}

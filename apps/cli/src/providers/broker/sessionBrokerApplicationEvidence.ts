import type { SessionRuntimeTeamCredentialDenialDetailsV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionBrokerApplicationOutcomeRecorder } from './providerBrokerApplicationFailure';
import { logger } from '@/ui/logger';
import type { MachineCarrierFailureDiagnostic } from '@/daemon/peer/iroh/machineCarrier';

export function recordSessionBrokerApplicationEvidenceRead(input: Readonly<{
  sessionId: string;
  turnId: string;
  pid: number;
  processStartTimeMs?: number;
}> & (Readonly<{ outcome: 'hit' }> | Readonly<{
  outcome: 'miss';
  reason: 'no_evidence' | 'turn_mismatch' | 'pid_mismatch';
  /** Fixed native carrier stage; a diagnostic, never a denial or authority fact. */
  carrierFailure?: MachineCarrierFailureDiagnostic;
}>)): void {
  try {
    logger.infoFile('[provider-broker-application]', {
      stage: 'evidence_read', sessionId: input.sessionId, turnId: input.turnId, pid: input.pid,
      ...(input.processStartTimeMs !== undefined ? { processStartTimeMs: input.processStartTimeMs } : {}),
      outcome: input.outcome, ...(input.outcome === 'miss' ? { reason: input.reason, ...input.carrierFailure } : {}),
    });
  } catch { /* Diagnostics cannot change the refusal read outcome. */ }
}

export type SessionBrokerApplicationFailureEvidence = Readonly<{
  denial: SessionRuntimeTeamCredentialDenialDetailsV1 | null;
  carrierFailure?: MachineCarrierFailureDiagnostic;
}>;

/** In-memory evidence owned by one host Session lifetime, never Agent state. */
export function createSessionBrokerApplicationEvidence(input: Readonly<{
  sessionId: string;
  pid: number;
  processStartTimeMs?: number;
  readActiveTurnId(): string | null;
  isCurrent(): boolean;
}>) {
  let lastDenial: Readonly<{ turnId: string; denial: SessionRuntimeTeamCredentialDenialDetailsV1 }> | null = null;
  let readCarrierFailure: (() => Promise<MachineCarrierFailureDiagnostic | undefined>) | undefined;
  return {
    /** The Session's current carrier. A request the native listener refuses
     * before stream admission never reaches `beginRequest`. */
    observeCarrierFailure(read: () => Promise<MachineCarrierFailureDiagnostic | undefined>): void {
      readCarrierFailure = read;
    },
    beginRequest(): SessionBrokerApplicationOutcomeRecorder {
      const turnId = input.readActiveTurnId();
      const admitted = !!turnId && input.isCurrent();
      const record = (outcome: 'captured' | 'skipped', reason?: 'no_admitted_turn' | 'turn_mismatch' | 'pid_mismatch') => {
        try {
          logger.infoFile('[provider-broker-application]', { stage: 'evidence_capture', sessionId: input.sessionId,
            turnId, pid: input.pid, ...(input.processStartTimeMs !== undefined ? { processStartTimeMs: input.processStartTimeMs } : {}),
            outcome, ...(reason ? { reason } : {}) });
        } catch { /* Diagnostics cannot change refusal custody. */ }
      };
      // Retain an outcome recorder even when no turn was admitted, so only an
      // actual refusal reports the missing attribution; successful probes stay quiet.
      return denial => {
        if (!turnId) { if (denial) record('skipped', 'no_admitted_turn'); return; }
        if (!admitted || !input.isCurrent()) { if (denial) record('skipped', 'pid_mismatch'); return; }
        if (input.readActiveTurnId() !== turnId) { if (denial) record('skipped', 'turn_mismatch'); return; }
        if (denial) { lastDenial = { turnId, denial }; record('captured'); }
        else if (lastDenial?.turnId === turnId) lastDenial = null;
      };
    },
    async readFailureEvidence(turnId: string): Promise<SessionBrokerApplicationFailureEvidence> {
      const current = input.isCurrent();
      const denial = current && lastDenial?.turnId === turnId ? lastDenial.denial : null;
      const reason = denial ? undefined : !current ? 'pid_mismatch' : lastDenial ? 'turn_mismatch' : 'no_evidence';
      let carrierFailure: MachineCarrierFailureDiagnostic | undefined;
      // Only an unexplained failure reads native status. It names where the
      // carrier closed and never becomes a refusal.
      if (reason === 'no_evidence') {
        try { carrierFailure = await readCarrierFailure?.(); } catch { /* Diagnostic only. */ }
      }
      recordSessionBrokerApplicationEvidenceRead({
        sessionId: input.sessionId, turnId, pid: input.pid,
        ...(input.processStartTimeMs !== undefined ? { processStartTimeMs: input.processStartTimeMs } : {}),
        ...(reason ? { outcome: 'miss', reason, ...(carrierFailure ? { carrierFailure } : {}) } : { outcome: 'hit' }),
      });
      return { denial, ...(carrierFailure ? { carrierFailure } : {}) };
    },
  };
}

export type SessionBrokerApplicationEvidence = ReturnType<typeof createSessionBrokerApplicationEvidence>;

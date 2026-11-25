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
  managedGatewayFailure?: 'broker_unavailable';
}>;

type ManagedGatewayFailure = NonNullable<SessionBrokerApplicationFailureEvidence['managedGatewayFailure']>;

type SessionBrokerFailure =
  | Readonly<{ kind: 'team'; denial: SessionRuntimeTeamCredentialDenialDetailsV1 }>
  | Readonly<{ kind: 'managed_gateway'; code: ManagedGatewayFailure }>;

/** In-memory evidence owned by one host Session lifetime, never Agent state. */
export function createSessionBrokerApplicationEvidence(input: Readonly<{
  sessionId: string;
  pid: number;
  processStartTimeMs?: number;
  readActiveTurnId(): string | null;
  isCurrent(): boolean;
}>) {
  let lastFailure: Readonly<{ turnId: string; failure: SessionBrokerFailure }> | null = null;
  let readCarrierFailure: (() => Promise<MachineCarrierFailureDiagnostic | undefined>) | undefined;

  function beginFailureCapture(): (failure: SessionBrokerFailure | null) => void {
    const turnId = input.readActiveTurnId();
    const admitted = !!turnId && input.isCurrent();
    const record = (outcome: 'captured' | 'skipped', reason?: 'no_admitted_turn' | 'turn_mismatch' | 'pid_mismatch') => {
      try {
        logger.infoFile('[provider-broker-application]', { stage: 'evidence_capture', sessionId: input.sessionId,
          turnId, pid: input.pid, ...(input.processStartTimeMs !== undefined ? { processStartTimeMs: input.processStartTimeMs } : {}),
          outcome, ...(reason ? { reason } : {}) });
      } catch { /* Diagnostics cannot change refusal custody. */ }
    };
    // Retain a recorder even without an admitted turn so only a refusal
    // reports missing attribution. Successful probes stay quiet.
    return failure => {
      if (!turnId) { if (failure) record('skipped', 'no_admitted_turn'); return; }
      if (!admitted || !input.isCurrent()) { if (failure) record('skipped', 'pid_mismatch'); return; }
      if (input.readActiveTurnId() !== turnId) { if (failure) record('skipped', 'turn_mismatch'); return; }
      if (failure) { lastFailure = { turnId, failure }; record('captured'); }
      else if (lastFailure?.turnId === turnId) lastFailure = null;
    };
  }

  return {
    /** The Session's current carrier. A request the native listener refuses
     * before stream admission never reaches `beginRequest`. */
    observeCarrierFailure(read: () => Promise<MachineCarrierFailureDiagnostic | undefined>): void {
      readCarrierFailure = read;
    },
    beginRequest(): SessionBrokerApplicationOutcomeRecorder {
      const capture = beginFailureCapture();
      return denial => capture(denial ? { kind: 'team', denial } : null);
    },
    beginManagedGatewayRequest(): (code: ManagedGatewayFailure | null) => void {
      const capture = beginFailureCapture();
      return code => capture(code ? { kind: 'managed_gateway', code } : null);
    },
    async readFailureEvidence(turnId: string): Promise<SessionBrokerApplicationFailureEvidence> {
      const current = input.isCurrent();
      const failure = current && lastFailure?.turnId === turnId ? lastFailure.failure : null;
      const reason = failure ? undefined : !current ? 'pid_mismatch' : lastFailure ? 'turn_mismatch' : 'no_evidence';
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
      return {
        denial: failure?.kind === 'team' ? failure.denial : null,
        ...(failure?.kind === 'managed_gateway' ? { managedGatewayFailure: failure.code } : {}),
        ...(carrierFailure ? { carrierFailure } : {}),
      };
    },
  };
}

export type SessionBrokerApplicationEvidence = ReturnType<typeof createSessionBrokerApplicationEvidence>;

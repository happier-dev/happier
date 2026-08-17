import type { VoiceSpeechDiagnosticsSettingsV1 } from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { setVoiceDiagnosticsSessionCaptureAllowed } from './capturePolicy';
import { createVoiceDiagnosticsClientForMachine } from './client';
import {
  addPersistedVoiceDiagnosticsMachineRevocation,
  clearPersistedVoiceDiagnosticsMachineRevocation,
  readPersistedVoiceDiagnosticsMachineRevocations,
} from './revocationObligationPersistence';
import {
  beginVoiceDiagnosticsRevocationObligation,
  clearVoiceDiagnosticsRevocationObligation,
  isCurrentVoiceDiagnosticsRevocationObligation,
  readVoiceDiagnosticsRevocationObligation,
  readVoiceDiagnosticsRuntimeStatus,
  replaceVoiceDiagnosticsMachineRevocationObligations,
  resolveVoiceDiagnosticsRevocationKey,
  updateVoiceDiagnosticsRevocationObligation,
  type VoiceDiagnosticsRevocationObligation,
  type VoiceDiagnosticsRevocationTarget,
} from './runtimeStatus';

export type VoiceDiagnosticsRevocationResult = Readonly<
  | { ok: true; acknowledged: boolean }
  | { ok: false; error: unknown }
>;

const sessionRevocationsInFlight = new Map<string, Promise<VoiceDiagnosticsRevocationResult>>();
const machinePolicyTails = new Map<string, Promise<void>>();
type MachinePolicyIntentKind = 'enable' | 'disable';
export type VoiceDiagnosticsMachinePolicyIntent<Kind extends MachinePolicyIntentKind = MachinePolicyIntentKind> = Readonly<{
  machineId: string;
  generation: number;
  kind: Kind;
  obligation: VoiceDiagnosticsRevocationObligation | null;
  persistenceScope: ServerAccountScope | null;
}>;
type MachinePolicyIntentState = Readonly<{
  intent: VoiceDiagnosticsMachinePolicyIntent;
  status: 'pending' | 'succeeded' | 'failed';
}>;
const machinePolicyIntentStates = new Map<string, MachinePolicyIntentState>();
const machinePolicyGenerations = new Map<string, number>();

function disabledDiagnosticsPolicy(settings: VoiceSpeechDiagnosticsSettingsV1): VoiceSpeechDiagnosticsSettingsV1 {
  return { ...settings, enabled: false, consentVersion: null };
}

function enqueueMachinePolicy<T>(machineId: string, operation: () => Promise<T>): Promise<T> {
  const previous = machinePolicyTails.get(machineId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => {
      if (machinePolicyTails.get(machineId) === tail) machinePolicyTails.delete(machineId);
    },
    () => {
      if (machinePolicyTails.get(machineId) === tail) machinePolicyTails.delete(machineId);
    },
  );
  machinePolicyTails.set(machineId, tail);
  return result;
}

function awaitSharedSessionRevocation(
  request: Promise<VoiceDiagnosticsRevocationResult>,
  signal?: AbortSignal | null,
): Promise<VoiceDiagnosticsRevocationResult> {
  if (!signal) return request;
  const waitSignal: AbortSignal = signal;
  if (waitSignal.aborted) {
    return Promise.resolve({ ok: false, error: new Error('voice_diagnostics_revocation_wait_aborted') });
  }
  return new Promise((resolve) => {
    let settled = false;
    function finish(result: VoiceDiagnosticsRevocationResult): void {
      if (settled) return;
      settled = true;
      waitSignal.removeEventListener('abort', onAbort);
      resolve(result);
    }
    function onAbort(): void {
      finish({ ok: false, error: new Error('voice_diagnostics_revocation_wait_aborted') });
    }
    waitSignal.addEventListener('abort', onAbort, { once: true });
    request.then(finish, (error) => finish({ ok: false, error }));
    if (waitSignal.aborted) onAbort();
  });
}

function runSessionRevocation(
  target: VoiceDiagnosticsRevocationTarget,
  operation: () => Promise<unknown>,
  signal?: AbortSignal | null,
): Promise<VoiceDiagnosticsRevocationResult> {
  const key = resolveVoiceDiagnosticsRevocationKey(target);
  const existing = sessionRevocationsInFlight.get(key);
  if (existing) return awaitSharedSessionRevocation(existing, signal);
  const obligation = beginVoiceDiagnosticsRevocationObligation(target, 'pending');

  const request = operation()
    .then((): VoiceDiagnosticsRevocationResult => {
      if (target.kind === 'session_authorization') {
        setVoiceDiagnosticsSessionCaptureAllowed(target.sessionId, false);
      }
      clearVoiceDiagnosticsRevocationObligation(obligation);
      return { ok: true, acknowledged: true };
    })
    .catch((error): VoiceDiagnosticsRevocationResult => {
      updateVoiceDiagnosticsRevocationObligation(obligation, 'failed');
      return { ok: false, error };
    })
    .finally(() => {
      if (sessionRevocationsInFlight.get(obligation.key) === request) {
        sessionRevocationsInFlight.delete(obligation.key);
      }
    });
  sessionRevocationsInFlight.set(obligation.key, request);
  return request;
}

function isLatestMachinePolicyIntent(intent: VoiceDiagnosticsMachinePolicyIntent): boolean {
  return machinePolicyIntentStates.get(intent.machineId)?.intent.generation === intent.generation;
}

function setMachinePolicyIntentStatus(
  intent: VoiceDiagnosticsMachinePolicyIntent,
  status: MachinePolicyIntentState['status'],
): void {
  if (!isLatestMachinePolicyIntent(intent)) return;
  machinePolicyIntentStates.set(intent.machineId, { intent, status });
}

export function declareVoiceDiagnosticsMachinePolicyIntent<Kind extends MachinePolicyIntentKind>(input: Readonly<{
  machineId: string;
  kind: Kind;
  persistenceScope?: ServerAccountScope | null;
}>): VoiceDiagnosticsMachinePolicyIntent<Kind> {
  const generation = (machinePolicyGenerations.get(input.machineId) ?? 0) + 1;
  machinePolicyGenerations.set(input.machineId, generation);
  const target = Object.freeze({ kind: 'machine_policy' as const, machineId: input.machineId });
  const existingObligation = readVoiceDiagnosticsRevocationObligation(target);
  const previousIntent = machinePolicyIntentStates.get(input.machineId)?.intent;
  // A failed default-off reconciliation means the daemon's current state is
  // unknown, but it is not itself evidence that diagnostics were ever enabled.
  // Persist only a disable that follows an enable attempt (whose outcome may
  // itself be unknown) or one that is already an exact-machine obligation.
  // This keeps real capture revocations fail-closed without turning a daemon
  // restart race into a durable warning for a user who never opted in.
  const shouldTrackDisable = input.kind === 'disable' && (
    existingObligation !== null || previousIntent?.kind === 'enable'
  );
  const obligation = shouldTrackDisable
    ? beginVoiceDiagnosticsRevocationObligation(target, 'pending')
    : existingObligation;
  const persistenceScope = input.persistenceScope ?? null;
  if (input.kind === 'disable' && obligation && persistenceScope) {
    // Persist before the request: a reload while the outcome is unknown must
    // retain the exact former-machine shutdown obligation.
    addPersistedVoiceDiagnosticsMachineRevocation(persistenceScope, input.machineId);
  }
  if (input.kind === 'enable' && obligation) {
    updateVoiceDiagnosticsRevocationObligation(obligation, 'pending');
  }
  const intent: VoiceDiagnosticsMachinePolicyIntent<Kind> = Object.freeze({
    machineId: input.machineId,
    generation,
    kind: input.kind,
    obligation,
    persistenceScope,
  });
  machinePolicyIntentStates.set(input.machineId, { intent, status: 'pending' });
  return intent;
}

async function applyDeclaredMachinePolicyIntent(input: Readonly<{
  intent: VoiceDiagnosticsMachinePolicyIntent;
  settings: VoiceSpeechDiagnosticsSettingsV1;
  signal?: AbortSignal;
}>) {
  return await enqueueMachinePolicy(input.intent.machineId, async () => {
    if (!isLatestMachinePolicyIntent(input.intent)) {
      return { applied: false as const, acknowledged: false as const };
    }
    try {
      const status = await createVoiceDiagnosticsClientForMachine(input.intent.machineId).configure(
        input.intent.kind === 'enable' ? input.settings : disabledDiagnosticsPolicy(input.settings),
        input.signal,
      );
      const acknowledged = isLatestMachinePolicyIntent(input.intent);
      if (acknowledged) {
        setMachinePolicyIntentStatus(input.intent, 'succeeded');
        if (input.intent.obligation) {
          clearVoiceDiagnosticsRevocationObligation(input.intent.obligation);
        }
        if (input.intent.persistenceScope) {
          clearPersistedVoiceDiagnosticsMachineRevocation(
            input.intent.persistenceScope,
            input.intent.machineId,
          );
        }
      }
      return { applied: true as const, acknowledged, status };
    } catch (error) {
      if (isLatestMachinePolicyIntent(input.intent)) {
        setMachinePolicyIntentStatus(input.intent, 'failed');
        if (input.intent.obligation) {
          updateVoiceDiagnosticsRevocationObligation(input.intent.obligation, 'failed');
        }
      }
      throw error;
    }
  });
}

export function disableVoiceDiagnosticsOnMachine(input: Readonly<{
  machineId: string;
  settings: VoiceSpeechDiagnosticsSettingsV1;
  signal?: AbortSignal;
  intent?: VoiceDiagnosticsMachinePolicyIntent<'disable'>;
}>): Promise<VoiceDiagnosticsRevocationResult> {
  const intent = input.intent ?? declareVoiceDiagnosticsMachinePolicyIntent({
    machineId: input.machineId,
    kind: 'disable',
  });
  return applyDeclaredMachinePolicyIntent({ intent, settings: input.settings, signal: input.signal })
    .then((result): VoiceDiagnosticsRevocationResult => ({
      ok: true,
      acknowledged: result.acknowledged,
    }))
    .catch((error): VoiceDiagnosticsRevocationResult => ({ ok: false, error }));
}

export function applyVoiceDiagnosticsMachinePolicy(input: Readonly<{
  machineId: string;
  settings: VoiceSpeechDiagnosticsSettingsV1;
  signal?: AbortSignal;
  intent?: VoiceDiagnosticsMachinePolicyIntent<'enable'>;
}>) {
  const intent = input.intent ?? declareVoiceDiagnosticsMachinePolicyIntent({
    machineId: input.machineId,
    kind: 'enable',
  });
  return applyDeclaredMachinePolicyIntent({ intent, settings: input.settings, signal: input.signal });
}

export function revokeVoiceDiagnosticsSessionAuthorization(input: Readonly<{
  machineId: string;
  sessionId: string;
  authorizationId: string;
  signal?: AbortSignal | null;
}>): Promise<VoiceDiagnosticsRevocationResult> {
  const { signal, ...targetInput } = input;
  const target = Object.freeze({ kind: 'session_authorization' as const, ...targetInput });
  return runSessionRevocation(
    target,
    async () => {
      const client = createVoiceDiagnosticsClientForMachine(input.machineId);
      return await (signal
        ? client.revokeCaptureAuthorization(input.authorizationId, signal)
        : client.revokeCaptureAuthorization(input.authorizationId));
    },
    signal,
  );
}

/**
 * A new daemon loses its in-memory authorization revocations. The runtime
 * currentness owner invokes this only after it observes that exact machine
 * reconnect. A request that was already pending at that boundary may fail
 * after the reconnect, so wait for it once and then retry through the same
 * session-revocation owner.
 */
export async function revalidateVoiceDiagnosticsSessionRevocationsAfterRuntimeReconnect(
  machineId: string,
  signal?: AbortSignal | null,
): Promise<void> {
  if (signal?.aborted) return;
  const obligations = readVoiceDiagnosticsRuntimeStatus().revocationObligations.filter(
    (candidate) => candidate.target.kind === 'session_authorization'
      && candidate.target.machineId === machineId,
  );
  await Promise.all(obligations.map(async (obligation) => {
    if (signal?.aborted) return;
    const target = obligation.target;
    if (target.kind !== 'session_authorization') return;
    const result = await revokeVoiceDiagnosticsSessionAuthorization({ ...target, signal });
    if (
      signal?.aborted
      || obligation.status !== 'pending'
      || result.ok
      || !isCurrentVoiceDiagnosticsRevocationObligation(obligation)
    ) return;
    await revokeVoiceDiagnosticsSessionAuthorization({ ...target, signal });
  }));
}

export function retryVoiceDiagnosticsRevocation(input: Readonly<{
  obligation: VoiceDiagnosticsRevocationObligation;
  settings: VoiceSpeechDiagnosticsSettingsV1;
  persistenceScope?: ServerAccountScope | null;
  signal?: AbortSignal | null;
}>): Promise<VoiceDiagnosticsRevocationResult> {
  if (!isCurrentVoiceDiagnosticsRevocationObligation(input.obligation)) {
    return Promise.resolve({ ok: true, acknowledged: false });
  }
  const { target } = input.obligation;
  if (target.kind === 'session_authorization') {
    return revokeVoiceDiagnosticsSessionAuthorization({ ...target, signal: input.signal });
  }
  const latest = machinePolicyIntentStates.get(target.machineId);
  if (latest?.intent.kind === 'enable' && latest.status !== 'failed') {
    return Promise.resolve({ ok: true, acknowledged: false });
  }
  const intent = declareVoiceDiagnosticsMachinePolicyIntent({
    machineId: target.machineId,
    kind: 'disable',
    persistenceScope: input.persistenceScope,
  });
  return disableVoiceDiagnosticsOnMachine({
    machineId: target.machineId,
    settings: input.settings,
    signal: input.signal ?? undefined,
    intent,
  });
}

export function restorePersistedVoiceDiagnosticsMachineRevocations(scope: ServerAccountScope): void {
  replaceVoiceDiagnosticsMachineRevocationObligations(
    readPersistedVoiceDiagnosticsMachineRevocations(scope),
  );
}

export function clearRestoredVoiceDiagnosticsMachineRevocations(): void {
  replaceVoiceDiagnosticsMachineRevocationObligations([]);
}

export function resetVoiceDiagnosticsRevocationForTests(): void {
  sessionRevocationsInFlight.clear();
  machinePolicyTails.clear();
  machinePolicyIntentStates.clear();
  machinePolicyGenerations.clear();
}

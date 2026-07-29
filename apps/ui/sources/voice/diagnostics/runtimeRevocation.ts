import type { VoiceSpeechDiagnosticsSettingsV1 } from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

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

function runSessionRevocation(
  target: VoiceDiagnosticsRevocationTarget,
  operation: () => Promise<unknown>,
): Promise<VoiceDiagnosticsRevocationResult> {
  const key = resolveVoiceDiagnosticsRevocationKey(target);
  const existing = sessionRevocationsInFlight.get(key);
  if (existing) return existing;
  const obligation = beginVoiceDiagnosticsRevocationObligation(target, 'pending');

  const request = operation()
    .then((): VoiceDiagnosticsRevocationResult => {
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
  const obligation = input.kind === 'disable'
    ? beginVoiceDiagnosticsRevocationObligation(target, 'pending')
    : existingObligation;
  const persistenceScope = input.persistenceScope ?? null;
  if (input.kind === 'disable' && persistenceScope) {
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
  intent?: VoiceDiagnosticsMachinePolicyIntent<'disable'>;
}>): Promise<VoiceDiagnosticsRevocationResult> {
  const intent = input.intent ?? declareVoiceDiagnosticsMachinePolicyIntent({
    machineId: input.machineId,
    kind: 'disable',
  });
  return applyDeclaredMachinePolicyIntent({ intent, settings: input.settings })
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
}>): Promise<VoiceDiagnosticsRevocationResult> {
  const target = Object.freeze({ kind: 'session_authorization' as const, ...input });
  return runSessionRevocation(
    target,
    async () => await createVoiceDiagnosticsClientForMachine(input.machineId)
      .revokeCaptureAuthorization(input.authorizationId),
  );
}

export function retryVoiceDiagnosticsRevocation(input: Readonly<{
  obligation: VoiceDiagnosticsRevocationObligation;
  settings: VoiceSpeechDiagnosticsSettingsV1;
  persistenceScope?: ServerAccountScope | null;
}>): Promise<VoiceDiagnosticsRevocationResult> {
  if (!isCurrentVoiceDiagnosticsRevocationObligation(input.obligation)) {
    return Promise.resolve({ ok: true, acknowledged: false });
  }
  const { target } = input.obligation;
  if (target.kind === 'session_authorization') {
    return revokeVoiceDiagnosticsSessionAuthorization(target);
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
  return disableVoiceDiagnosticsOnMachine({ machineId: target.machineId, settings: input.settings, intent });
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

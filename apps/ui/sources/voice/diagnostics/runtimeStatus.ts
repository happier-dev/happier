import * as React from 'react';

export type VoiceDiagnosticsRuntimePhase = 'inactive_confirmed' | 'transitioning' | 'active' | 'status_unknown';
type VoiceDiagnosticsRuntimeSelection = Readonly<
  | { machineId: string; phase: 'active' }
  | { machineId: string | null; phase: Exclude<VoiceDiagnosticsRuntimePhase, 'active'> }
>;

export type VoiceDiagnosticsRevocationTarget = Readonly<
  | { kind: 'machine_policy'; machineId: string }
  | { kind: 'session_authorization'; machineId: string; sessionId: string; authorizationId: string }
>;

export type VoiceDiagnosticsRevocationObligation = Readonly<{
  key: string;
  revision: number;
  target: VoiceDiagnosticsRevocationTarget;
  status: 'pending' | 'failed';
}>;

export type VoiceDiagnosticsRuntimeStatus = Readonly<VoiceDiagnosticsRuntimeSelection & {
  revocationObligations: readonly VoiceDiagnosticsRevocationObligation[];
}>;

let snapshot: VoiceDiagnosticsRuntimeStatus = Object.freeze({
  machineId: null,
  phase: 'inactive_confirmed',
  revocationObligations: Object.freeze([]),
});
const listeners = new Set<() => void>();
let nextObligationRevision = 1;

function notify(): void {
  for (const listener of listeners) listener();
}

export function resolveVoiceDiagnosticsRevocationKey(target: VoiceDiagnosticsRevocationTarget): string {
  return target.kind === 'machine_policy'
    ? `machine:${target.machineId}`
    : `session:${target.machineId}:${target.authorizationId}`;
}

export function publishVoiceDiagnosticsRuntimeStatus(
  next: VoiceDiagnosticsRuntimeSelection,
): void {
  if (snapshot.machineId === next.machineId && snapshot.phase === next.phase) return;
  snapshot = Object.freeze({ ...next, revocationObligations: snapshot.revocationObligations });
  notify();
}

export function beginVoiceDiagnosticsRevocationObligation(
  target: VoiceDiagnosticsRevocationTarget,
  status: VoiceDiagnosticsRevocationObligation['status'],
): VoiceDiagnosticsRevocationObligation {
  const key = resolveVoiceDiagnosticsRevocationKey(target);
  const next = Object.freeze({
    key,
    revision: nextObligationRevision++,
    target: Object.freeze({ ...target }),
    status,
  });
  const existingIndex = snapshot.revocationObligations.findIndex((candidate) => candidate.key === key);
  const obligations = existingIndex < 0
    ? [...snapshot.revocationObligations, next]
    : snapshot.revocationObligations.map((candidate, index) => index === existingIndex ? next : candidate);
  snapshot = Object.freeze({ ...snapshot, revocationObligations: Object.freeze(obligations) });
  notify();
  return next;
}

export function updateVoiceDiagnosticsRevocationObligation(
  obligation: VoiceDiagnosticsRevocationObligation,
  status: VoiceDiagnosticsRevocationObligation['status'],
): boolean {
  const existingIndex = snapshot.revocationObligations.findIndex(
    (candidate) => candidate.key === obligation.key && candidate.revision === obligation.revision,
  );
  if (existingIndex < 0) return false;
  const existing = snapshot.revocationObligations[existingIndex]!;
  if (existing.status === status) return true;
  const next = Object.freeze({ ...existing, status });
  snapshot = Object.freeze({
    ...snapshot,
    revocationObligations: Object.freeze(snapshot.revocationObligations.map(
      (candidate, index) => index === existingIndex ? next : candidate,
    )),
  });
  notify();
  return true;
}

export function clearVoiceDiagnosticsRevocationObligation(
  obligation: VoiceDiagnosticsRevocationObligation,
): boolean {
  const obligations = snapshot.revocationObligations.filter(
    (candidate) => candidate.key !== obligation.key || candidate.revision !== obligation.revision,
  );
  if (obligations.length === snapshot.revocationObligations.length) return false;
  snapshot = Object.freeze({ ...snapshot, revocationObligations: Object.freeze(obligations) });
  notify();
  return true;
}

export function readVoiceDiagnosticsRevocationObligation(
  target: VoiceDiagnosticsRevocationTarget,
): VoiceDiagnosticsRevocationObligation | null {
  const key = resolveVoiceDiagnosticsRevocationKey(target);
  return snapshot.revocationObligations.find((candidate) => candidate.key === key) ?? null;
}

export function replaceVoiceDiagnosticsMachineRevocationObligations(
  machineIds: readonly string[],
): void {
  const desiredMachineIds = [...new Set(machineIds)];
  const desiredKeys = new Set(desiredMachineIds.map((machineId) => (
    resolveVoiceDiagnosticsRevocationKey({ kind: 'machine_policy', machineId })
  )));
  const sessionObligations = snapshot.revocationObligations.filter(
    (candidate) => candidate.target.kind === 'session_authorization',
  );
  const existingMachineObligations = new Map(snapshot.revocationObligations
    .filter((candidate) => candidate.target.kind === 'machine_policy' && desiredKeys.has(candidate.key))
    .map((candidate) => [candidate.key, candidate] as const));
  const machineObligations = desiredMachineIds.map((machineId) => {
    const target = Object.freeze({ kind: 'machine_policy' as const, machineId });
    const key = resolveVoiceDiagnosticsRevocationKey(target);
    return existingMachineObligations.get(key) ?? Object.freeze({
      key,
      revision: nextObligationRevision++,
      target,
      status: 'failed' as const,
    });
  });
  const obligations = Object.freeze([...sessionObligations, ...machineObligations]);
  if (
    obligations.length === snapshot.revocationObligations.length
    && obligations.every((candidate, index) => candidate === snapshot.revocationObligations[index])
  ) return;
  snapshot = Object.freeze({ ...snapshot, revocationObligations: obligations });
  notify();
}

export function isCurrentVoiceDiagnosticsRevocationObligation(
  obligation: VoiceDiagnosticsRevocationObligation,
): boolean {
  return snapshot.revocationObligations.some(
    (candidate) => candidate.key === obligation.key && candidate.revision === obligation.revision,
  );
}

export function readVoiceDiagnosticsRuntimeStatus(): VoiceDiagnosticsRuntimeStatus {
  return snapshot;
}

export function useVoiceDiagnosticsRuntimeStatus(): VoiceDiagnosticsRuntimeStatus {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readVoiceDiagnosticsRuntimeStatus,
    readVoiceDiagnosticsRuntimeStatus,
  );
}

export function resetVoiceDiagnosticsRuntimeStatusForTests(): void {
  snapshot = Object.freeze({
    machineId: null,
    phase: 'inactive_confirmed',
    revocationObligations: Object.freeze([]),
  });
  nextObligationRevision = 1;
  listeners.clear();
}

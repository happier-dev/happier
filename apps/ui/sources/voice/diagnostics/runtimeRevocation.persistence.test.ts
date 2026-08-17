import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistedByScope = new Map<string, string[]>();
const configure = vi.fn();

vi.mock('./revocationObligationPersistence', () => ({
  addPersistedVoiceDiagnosticsMachineRevocation: (scope: { serverId: string; accountId: string }, machineId: string) => {
    const key = `${scope.serverId}:${scope.accountId}`;
    persistedByScope.set(key, [...new Set([...(persistedByScope.get(key) ?? []), machineId])]);
  },
  clearPersistedVoiceDiagnosticsMachineRevocation: (scope: { serverId: string; accountId: string }, machineId: string) => {
    const key = `${scope.serverId}:${scope.accountId}`;
    persistedByScope.set(key, (persistedByScope.get(key) ?? []).filter((candidate) => candidate !== machineId));
  },
  readPersistedVoiceDiagnosticsMachineRevocations: (scope: { serverId: string; accountId: string }) => (
    persistedByScope.get(`${scope.serverId}:${scope.accountId}`) ?? []
  ),
}));

vi.mock('./client', () => ({
  createVoiceDiagnosticsClientForMachine: () => ({ configure }),
}));

import {
  applyVoiceDiagnosticsMachinePolicy,
  declareVoiceDiagnosticsMachinePolicyIntent,
  disableVoiceDiagnosticsOnMachine,
  resetVoiceDiagnosticsRevocationForTests,
  restorePersistedVoiceDiagnosticsMachineRevocations,
  retryVoiceDiagnosticsRevocation,
} from './runtimeRevocation';
import {
  readVoiceDiagnosticsRuntimeStatus,
  resetVoiceDiagnosticsRuntimeStatusForTests,
} from './runtimeStatus';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const settings = Object.freeze({
  v: 1 as const,
  enabled: true,
  consentVersion: 1 as const,
  captureSttInput: true,
  captureTtsOutput: false,
  maxAgeMs: 60_000,
  maxFiles: 10,
  maxBytes: 1024,
  maxDurationMs: 60_000,
});

describe('voice diagnostics revocation reload continuity', () => {
  beforeEach(() => {
    persistedByScope.clear();
    configure.mockReset();
    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsRuntimeStatusForTests();
  });

  it('restores an unresolved former-machine shutdown after process state is lost and clears it only on acknowledgement', async () => {
    // A durable shutdown obligation represents a prior enabled (or otherwise
    // already tracked) machine policy, not a first default-off reconciliation.
    configure.mockResolvedValueOnce({ settings });
    await applyVoiceDiagnosticsMachinePolicy({
      machineId: 'machine-former',
      settings,
    });
    configure.mockRejectedValueOnce(new Error('former_machine_unreachable'));
    const intent = declareVoiceDiagnosticsMachinePolicyIntent({
      machineId: 'machine-former',
      kind: 'disable',
      persistenceScope: scope,
    });
    await expect(disableVoiceDiagnosticsOnMachine({
      machineId: 'machine-former',
      settings,
      intent,
    })).resolves.toMatchObject({ ok: false });
    expect(persistedByScope.get('server-a:account-a')).toEqual(['machine-former']);

    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsRuntimeStatusForTests();
    restorePersistedVoiceDiagnosticsMachineRevocations(scope);
    const restored = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    expect(restored).toMatchObject({
      target: { kind: 'machine_policy', machineId: 'machine-former' },
      status: 'failed',
    });

    configure.mockResolvedValueOnce({ ok: true, settings: { ...settings, enabled: false, consentVersion: null } });
    await expect(retryVoiceDiagnosticsRevocation({
      obligation: restored,
      settings,
      persistenceScope: scope,
    })).resolves.toEqual({ ok: true, acknowledged: true });
    expect(persistedByScope.get('server-a:account-a')).toEqual([]);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
  });

  it('replaces machine obligations when the active account scope changes', () => {
    persistedByScope.set('server-a:account-a', ['machine-a']);
    persistedByScope.set('server-a:account-b', ['machine-b']);

    restorePersistedVoiceDiagnosticsMachineRevocations(scope);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ target: { kind: 'machine_policy', machineId: 'machine-a' } }),
    ]);

    restorePersistedVoiceDiagnosticsMachineRevocations({ serverId: 'server-a', accountId: 'account-b' });
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ target: { kind: 'machine_policy', machineId: 'machine-b' } }),
    ]);
  });
});

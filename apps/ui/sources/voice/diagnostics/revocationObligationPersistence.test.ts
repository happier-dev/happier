import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();

vi.mock('@/sync/domains/state/persistenceStorage', () => ({
  getPersistenceStorage: () => ({
    getString: (key: string) => values.get(key),
    set: (key: string, value: string) => values.set(key, value),
    delete: (key: string) => values.delete(key),
  }),
}));

import {
  addPersistedVoiceDiagnosticsMachineRevocation,
  clearPersistedVoiceDiagnosticsMachineRevocation,
  readPersistedVoiceDiagnosticsMachineRevocations,
} from './revocationObligationPersistence';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';

const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
const scopeB = { serverId: 'server-a', accountId: 'account-b' } as const;

describe('voice diagnostics exact-machine revocation persistence', () => {
  beforeEach(() => values.clear());

  it('keeps only unresolved machine ids in the exact server-account scope', () => {
    addPersistedVoiceDiagnosticsMachineRevocation(scopeA, 'machine-1');
    addPersistedVoiceDiagnosticsMachineRevocation(scopeA, 'machine-2');
    addPersistedVoiceDiagnosticsMachineRevocation(scopeA, 'machine-1');

    expect(readPersistedVoiceDiagnosticsMachineRevocations(scopeA)).toEqual(['machine-1', 'machine-2']);
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scopeB)).toEqual([]);

    clearPersistedVoiceDiagnosticsMachineRevocation(scopeA, 'machine-1');
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scopeA)).toEqual(['machine-2']);
  });

  it('fails closed on malformed persisted values without creating session opt-out state', () => {
    values.set(
      serverAccountScopedStorageKey('voice-diagnostics-machine-revocations-v1', scopeA),
      JSON.stringify({ v: 1, machineIds: ['', 42, 'ok-machine', 'x'.repeat(1025)] }),
    );

    expect(readPersistedVoiceDiagnosticsMachineRevocations(scopeA)).toEqual(['ok-machine']);
  });
});

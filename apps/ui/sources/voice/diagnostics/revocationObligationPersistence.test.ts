import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

import {
  addPersistedVoiceDiagnosticsMachineRevocation,
  clearPersistedVoiceDiagnosticsMachineRevocation,
  readPersistedVoiceDiagnosticsMachineRevocations,
} from './revocationObligationPersistence';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';

const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
const scopeB = { serverId: 'server-a', accountId: 'account-b' } as const;

function clearFixtures() {
  for (const scope of [scopeA, scopeB]) getPersistenceStorage().delete(
    serverAccountScopedStorageKey('voice-diagnostics-machine-revocations-v1', scope),
  );
}
afterEach(clearFixtures);

describe('voice diagnostics exact-machine revocation persistence', () => {
  beforeEach(clearFixtures);

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
    getPersistenceStorage().set(
      serverAccountScopedStorageKey('voice-diagnostics-machine-revocations-v1', scopeA),
      JSON.stringify({ v: 1, machineIds: ['', 42, 'ok-machine', 'x'.repeat(1025)] }),
    );

    expect(readPersistedVoiceDiagnosticsMachineRevocations(scopeA)).toEqual(['ok-machine', 'x'.repeat(1025)]);
  });

  it('retains every unresolved Machine for the next reconnect instead of dropping older shutdowns at 64', () => {
    const machineIds = Array.from({ length: 65 }, (_, index) => `machine-${index}`);
    for (const machineId of machineIds) addPersistedVoiceDiagnosticsMachineRevocation(scopeA, machineId);
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scopeA)).toEqual(machineIds);
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scopeB)).toEqual([]);
  });
});

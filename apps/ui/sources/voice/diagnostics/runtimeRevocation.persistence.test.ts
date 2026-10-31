import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSpeechDiagnosticsConfigureRequestV1Schema, VoiceSpeechDiagnosticsSettingsV1Schema, VoiceSpeechDiagnosticsStatusResponseV1Schema,
  resolveVoiceSpeechDiagnosticsStoragePolicy } from '@happier-dev/protocol/voice/diagnostics';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { addPersistedVoiceDiagnosticsMachineRevocation, readPersistedVoiceDiagnosticsMachineRevocations } from './revocationObligationPersistence';
import { createMachineFixture } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

const configure = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

installSessionActionRpcBoundary(request => {
  VoiceSpeechDiagnosticsConfigureRequestV1Schema.parse(request.params);
  return configure(request);
});
const { storage } = await import('@/sync/domains/state/storage');

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

let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
let scope: Readonly<{ serverId: string; accountId: string }>;
const settings = VoiceSpeechDiagnosticsSettingsV1Schema.parse({
  v: 1 as const,
  enabled: true,
  consentVersion: 1 as const,
  captureSttInput: true,
  captureTtsOutput: false,
});

function response(policy: typeof settings) {
  return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({ ok: true,
    root: '/private/voice-diagnostics', settings: policy, artifacts: [],
    health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
    backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'),
  });
}

function clearPersistedFixtures() {
  for (const accountId of ['account-a', 'account-b']) getPersistenceStorage().delete(
    serverAccountScopedStorageKey('voice-diagnostics-machine-revocations-v1', { serverId: scope.serverId, accountId }),
  );
}
afterEach(async () => {
  clearPersistedFixtures();
  await disconnect?.();
  await home?.dispose();
});

describe('voice diagnostics revocation reload continuity', () => {
  beforeEach(async () => {
    home = await serveAccountHomes({ homes: [{ key: 'diagnostics', serverUrl: 'https://diagnostics.test', accountId: 'account-a' }],
      route: ({ path, method, body }) => createPlainMachineReadHttpResponseFixture(path,
        { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'account-a') ?? undefined });
    disconnect = await home.restoreActiveConnection();
    scope = { serverId: home.homes.diagnostics!.id, accountId: 'account-a' };
    const machine = createMachineFixture({ id: 'machine-former', activeAt: Date.now(), storageMode: 'plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] } });
    clearPersistedFixtures();
    configure.mockReset();
    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsRuntimeStatusForTests();
  });

  it('restores an unresolved former-machine shutdown after process state is lost and clears it only on acknowledgement', async () => {
    // A durable shutdown obligation represents a prior enabled (or otherwise
    // already tracked) machine policy, not a first default-off reconciliation.
    configure.mockResolvedValueOnce(response(settings));
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
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual(['machine-former']);

    resetVoiceDiagnosticsRevocationForTests();
    resetVoiceDiagnosticsRuntimeStatusForTests();
    restorePersistedVoiceDiagnosticsMachineRevocations(scope);
    const restored = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    expect(restored).toMatchObject({
      target: { kind: 'machine_policy', machineId: 'machine-former' },
      status: 'failed',
    });

    // Omitting the real client's strict-consumer fields must not acknowledge
    // shutdown or erase the durable obligation (the old client stub did).
    configure.mockResolvedValueOnce({ ok: true, settings: { ...settings, enabled: false, consentVersion: null } });
    await expect(retryVoiceDiagnosticsRevocation({ obligation: restored, settings, persistenceScope: scope }))
      .resolves.toMatchObject({ ok: false });
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual(['machine-former']);
    const retry = readVoiceDiagnosticsRuntimeStatus().revocationObligations[0]!;
    expect(retry.status).toBe('failed');
    configure.mockResolvedValueOnce(response({ ...settings, enabled: false, consentVersion: null }));
    await expect(retryVoiceDiagnosticsRevocation({
      obligation: retry,
      settings,
      persistenceScope: scope,
    })).resolves.toEqual({ ok: true, acknowledged: true });
    expect(readPersistedVoiceDiagnosticsMachineRevocations(scope)).toEqual([]);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([]);
  });

  it('replaces machine obligations when the active account scope changes', () => {
    addPersistedVoiceDiagnosticsMachineRevocation(scope, 'machine-a');
    addPersistedVoiceDiagnosticsMachineRevocation({ ...scope, accountId: 'account-b' }, 'machine-b');

    restorePersistedVoiceDiagnosticsMachineRevocations(scope);
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ target: { kind: 'machine_policy', machineId: 'machine-a' } }),
    ]);

    restorePersistedVoiceDiagnosticsMachineRevocations({ ...scope, accountId: 'account-b' });
    expect(readVoiceDiagnosticsRuntimeStatus().revocationObligations).toEqual([
      expect.objectContaining({ target: { kind: 'machine_policy', machineId: 'machine-b' } }),
    ]);
  });
});

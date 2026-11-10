import { expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { ConnectedServiceBindingsV2Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import * as daemonControl from '@/daemon/controlClient';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { recordProviderAccountUsageSnapshotForSession } from '@/daemon/connectedServices/accountUsage/recordProviderAccountUsageSnapshotForSession';
import { createProviderAccountUsagePersistenceScheduler } from '@/daemon/connectedServices/accountUsage/persistence';
import { buildProviderAccountUsageIdentityFromQualifiedAccount, buildProviderAccountUsagePersistenceTargetFromQualifiedCredential } from '@/daemon/connectedServices/accountUsage/qualifiedAccountIdentity';
import { resolveProviderAccountUsageAuthoritativeSource } from '@/daemon/connectedServices/accountUsage/runtimeSource';
import { readQualifiedConnectedAccountCredentialMaterial } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { MUSE_ACCOUNT_SERVICE, museAccountDescriptor } from '../connectedAccounts/declarations.js';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseLoginRecording } from './testkit/mspProcess.js';
import { readMuseRecord } from './events.js';

it.each([false, true])('pushes native allowance into the real usage owner (selected account: %s), retaining equal samples', async selected => {
  const captured = readMuseRecord(await readMuseLoginRecording());
  if (!Array.isArray(captured.rows)) throw new Error('Expected native recording rows');
  const usageRow = captured.rows.find(row => readMuseRecord(readMuseRecord(row).message).method === 'usage/changed');
  const usageMessage = readMuseRecord(readMuseRecord(usageRow).message);
  const nativeSample = readMuseRecord(usageMessage.params);
  const changed = { ...nativeSample, observedAtMs: Number(nativeSample.observedAtMs) + 1,
    weekly: { ...readMuseRecord(nativeSample.weekly), usedPercent: 9 } };
  const rows = captured.rows.flatMap(row => row === usageRow
    ? [{}, { schemaVersion: 999 }, nativeSample, nativeSample, changed, {}, { schemaVersion: 999 }].map(params => ({
        ...readMuseRecord(row), message: { ...usageMessage, params },
      }))
    : [row]);
  const store = createProviderAccountUsageStore();
  const results: string[] = [];
  const retained: ReturnType<typeof store.listSnapshots>[number][] = [];
  const credentials = { token: 'synthetic-token', encryption: null };
  const ref = { service: MUSE_ACCOUNT_SERVICE, accountId: 'work' };
  const serviceId = buildQualifiedPluginContributionKey(MUSE_ACCOUNT_SERVICE);
  const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const environment = { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
    { kind: 'profile', serviceId, profileId: ref.accountId, credentialRevision },
  ]) };
  const registry = new ConnectedServiceRuntimeRegistry();
  if (selected) registry.registerTarget({ pid: process.pid, agentId: 'muse', sessionId: 'host-admitted-muse',
    connectedServicesBindingsRaw: ConnectedServiceBindingsV2Schema.parse({ v: 2,
      bindingsByServiceId: { [serviceId]: { source: 'connected', profileId: ref.accountId } } }),
    connectedServiceSelectionsEnv: environment });
  const usageCredential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref,
      authenticationModeId: 'api-key', configurationRevision: 'cfg-work', revisionSemantics: 'revisioned', credentialRevision,
      content: { t: 'plain', v: { v: 1, values: { inferenceKey: 'synthetic-key', credentialMode: 'manual' } } },
      metadata: { scopes: [], providerIdentity: { accountId: 'acct_native' } },
  });
  const persistence = createProviderAccountUsagePersistenceScheduler({ credentials,
    // All replayed samples have already occurred; do not make the changed sample future-dated.
    api: { getAccountEncryptionMode: async () => 'plain' }, now: () => Number(changed.observedAtMs),
    fingerprintKey: new Uint8Array(32).fill(3) });
  let admittedMaterial: Awaited<ReturnType<typeof readQualifiedConnectedAccountCredentialMaterial>> = null;
  // Daemon IPC is the replaced process boundary; canonical intake and storage remain real.
  const ipc = vi.spyOn(daemonControl, 'notifyDaemonProviderAccountUsageSnapshot').mockImplementation(async input => {
    const result = await recordProviderAccountUsageSnapshotForSession({
      getChildren: () => [{ happySessionId: 'host-admitted-muse' }],
      store, persistence: selected ? persistence : null, sessionId: input.sessionId, snapshot: input.snapshot,
      ...(input.source ? { observation: { sources: [input.source] } } : {}),
      resolveAuthoritativeSource: async source => resolveProviderAccountUsageAuthoritativeSource({ source,
        activeBindings: registry.getBySessionId(input.sessionId)?.activeBindings ?? [] }),
      resolveRuntimeSourceIdentity: async () => {
        admittedMaterial = await readQualifiedConnectedAccountCredentialMaterial({ credentials, account: ref,
          getAccountEncryptionMode: async () => 'plain' });
        return admittedMaterial ? buildProviderAccountUsageIdentityFromQualifiedAccount({ ref,
          providerIdentity: admittedMaterial.snapshot.metadata.providerIdentity,
          usageIdentity: museAccountDescriptor.usageIdentity }) : null;
      },
      resolvePersistenceTargets: async ({ sources }) => {
        const material = admittedMaterial;
        return material ? sources.map(source => buildProviderAccountUsagePersistenceTargetFromQualifiedCredential({ source,
          snapshot: material.snapshot })) : [];
      },
    });
    results.push(result.status);
    retained.push(...store.listSnapshots());
    return { ok: true, result };
  });
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording: { ...captured, rows } satisfies JsonValue },
    ...(selected ? { environment, usageCredential } : {}) });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd(),
      ...(selected ? { launchEnvironment: { values: environment, unset: [] } } : {}) });
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['usage-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'usage-turn' } });
    await events.until('turn-complete');
    await vi.waitFor(() => expect(results).toEqual(['snapshot_advanced', 'duplicate', 'snapshot_advanced']));
    expect(retained[1]).toBe(retained[0]);
    expect(retained[2]).not.toBe(retained[0]);
    expect(retained[0]).toMatchObject({ providerId: 'meta', observedAtMs: nativeSample.observedAtMs,
      fetchedAtMs: nativeSample.observedAtMs, staleAfterMs: 1, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
      planLabel: nativeSample.tier, meters: [
        { meterId: 'weekly', used: 1, remainingPct: 99, resetsAt: 1794787200000 },
        { meterId: 'window', used: 5, remainingPct: 95, resetsAt: 1794232717000, windowDurationMs: 18000000 },
      ],
    });
    expect(store.listSnapshots()).toHaveLength(1);
    expect(store.listSnapshots()[0]).toMatchObject({ observedAtMs: changed.observedAtMs,
      meters: [{ meterId: 'weekly', used: 9 }, { meterId: 'window', used: 5 }] });
    await persistence.flush(5000);
    const writes = fixture.usageWrites;
    if (selected) {
      // The canonical persistence queue may coalesce successive observations to the latest one.
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.at(-1)).toMatchObject({ source: { ref, bindingKind: 'account' }, expectedCredentialRevision: credentialRevision,
        snapshot: { accountSubject: { kind: 'providerSubject', id: 'acct_native' },
          recordKey: { accountSubjectId: 'acct_native', subjectKind: 'account' },
          observedAtMs: changed.observedAtMs, fetchedAtMs: changed.observedAtMs,
          meters: [{ meterId: 'weekly', used: 9 }, { meterId: 'window', used: 5 }] } });
      expect(store.resolveBySource({ serviceId, profileId: ref.accountId, bindingKind: 'profile' })).toBe(store.listSnapshots()[0]);
    } else {
      expect(writes).toEqual([]);
      expect(fixture.boundaryRequests.filter(request => request.path === '/v4/connect/qualified/credential')).toEqual([]);
    }
    expect(fixture.launchCount).toBe(1);
    expect((await fixture.readAudit()).methods).toEqual(['initialize', 'initialized', 'session/start', 'turn/start']);
  } finally {
    events.dispose();
    await fixture.dispose();
    ipc.mockRestore();
    persistence.dispose();
  }
});

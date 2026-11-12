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
  // Real login capture has an empty usage/read cache. The native refresh
  // result adds tierName/subscriptionActive to the same observed usage payload.
  const usageRequest = captured.rows.find(row => readMuseRecord(readMuseRecord(row).message).method === 'usage/read');
  const usageReadId = readMuseRecord(readMuseRecord(usageRequest).message).id;
  const rows = captured.rows.flatMap(row => row === usageRequest
    ? [{ ...readMuseRecord(row), message: { ...readMuseRecord(readMuseRecord(row).message), method: 'usage/refresh' } }]
    : readMuseRecord(row).direction === 'recv'
    && readMuseRecord(readMuseRecord(row).message).id === usageReadId
    ? [{ ...readMuseRecord(row), message: { ...readMuseRecord(readMuseRecord(row).message), result: { usage: nativeSample, tierName: 'Native subscription', subscriptionActive: true } } }]
    : row === usageRow
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
      authenticationModeId: 'native-import', configurationRevision: 'cfg-work', revisionSemantics: 'revisioned', credentialRevision,
      content: { t: 'plain', v: { v: 1, values: { credentialMode: 'native', accountToken: 'synthetic-oauth-token',
        nativeMechanism: '"oauth"', nativeApiBaseUrl: 'https://api.meta.ai/v1', nativeObtainedVia: 'login',
        nativeSubsActive: 'true', expiresAtMs: String(Date.UTC(2100, 0, 1)),
      } } },
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
    // Existing credentials have no initial cache: refresh must publish before a turn.
    await vi.waitFor(() => expect(results).toEqual(['snapshot_advanced']));
    expect(store.listSnapshots()[0]?.planLabel).toBe('Native subscription');
    expect(store.listSnapshots()[0]?.meters.map(meter => meter.meterId)).toEqual(['weekly', 'window']);
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['usage-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'usage-turn' } });
    await events.until('turn-complete');
    await vi.waitFor(() => expect(results).toEqual(['snapshot_advanced', 'snapshot_advanced', 'duplicate', 'snapshot_advanced']));
    // Refresh carries a display label; bare notifications carry only a tier id.
    // Their first projection differs, then equal bare samples are duplicates.
    expect(retained[1]).not.toBe(retained[0]);
    expect(retained[1]).not.toHaveProperty('planLabel');
    expect(retained[2]).toBe(retained[1]);
    expect(retained[3]).not.toBe(retained[2]);
    expect(retained[0]).toMatchObject({ providerId: 'meta', observedAtMs: nativeSample.observedAtMs,
      fetchedAtMs: nativeSample.observedAtMs, staleAfterMs: 1, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
      planLabel: 'Native subscription', meters: [
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
    expect((await fixture.readAudit()).methods).toEqual(['initialize', 'initialized', 'session/start', 'usage/refresh', 'turn/start']);
  } finally {
    events.dispose();
    await fixture.dispose();
    ipc.mockRestore();
    persistence.dispose();
  }
});


it('does not mint subscription usage for a known key launch and still completes its first turn', async () => {
  const captured = readMuseRecord(await readMuseLoginRecording());
  if (!Array.isArray(captured.rows)) throw new Error('Expected native recording rows');
  const rows = captured.rows.filter(row => readMuseRecord(readMuseRecord(row).message).method !== 'usage/changed');
  const environment = { META_API_KEY: 'synthetic-selected-muse-key' };
  const fixture = await createAdmittedMuseSessionFixture({ environment, native: { recording: { ...captured, rows } satisfies JsonValue } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd(),
      launchEnvironment: { values: environment, unset: [] } });
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['key-input'], input: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
      delivery: { kind: 'newTurn', turnId: 'key-turn' } });
    await events.until('turn-complete');
    expect((await fixture.readAudit()).methods).not.toContain('usage/refresh');
    expect(fixture.usageWrites).toEqual([]);
  } finally {
    events.dispose();
    await fixture.dispose();
  }
});

it.each([
  { code: -32080, data: { kind: 'usageRefreshRateLimited', retryable: true, retryAfterMs: 54321 } },
  { code: -32081, data: { kind: 'usageRefreshUnavailable', retryable: false } },
  { code: -32082, data: { kind: 'usageRefreshFailed', retryable: true, failureKind: 'transient' } },
])('retains typed native refresh cause $code without blocking startup or retrying', async ({ code, data }) => {
  const captured = readMuseRecord(await readMuseLoginRecording());
  if (!Array.isArray(captured.rows)) throw new Error('Expected native recording rows');
  const request = captured.rows.find(row => readMuseRecord(readMuseRecord(row).message).method === 'usage/read');
  const requestId = readMuseRecord(readMuseRecord(request).message).id;
  const rows = captured.rows.map(row => {
    const message = readMuseRecord(readMuseRecord(row).message);
    if (row === request) return { ...readMuseRecord(row), message: { ...message, method: 'usage/refresh' } };
    if (readMuseRecord(row).direction !== 'recv' || message.id !== requestId) return row;
    const { result: _result, ...response } = message;
    return { ...readMuseRecord(row), message: { ...response, error: {
      code, message: 'synthetic-sensitive-provider-message', data: { ...data, credential: 'synthetic-sensitive-credential' },
    } } };
  });
  // Exact receive windows retain native error frames; default playback projects results only.
  const playbackSteps = ['session/start', 'usage/refresh'].map(method => {
    const requestRow = rows.findIndex(row => readMuseRecord(readMuseRecord(row).message).method === method);
    const id = readMuseRecord(readMuseRecord(rows[requestRow]).message).id;
    const responseRow = rows.findIndex((row, index) => index > requestRow && readMuseRecord(row).direction === 'recv'
      && readMuseRecord(readMuseRecord(row).message).id === id);
    if (requestRow < 0 || responseRow < 0) throw new Error('Missing native request/response fixture');
    return { requestRow, receiveUntilRow: responseRow + 1 };
  });
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording: { ...captured, rows } satisfies JsonValue, playbackSteps } });
  // The fixture observes and forwards the real logger; JSON-RPC/runtime remain intact.
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    expect(session).toBeDefined();
    await vi.waitFor(() => expect(fixture.warnings).toContainEqual(['Muse initial usage refresh was unavailable', {
      code, ...data,
    }]));
    await fixture.closeSession();
    expect((await fixture.readAudit()).methods.filter(method => method === 'usage/refresh')).toHaveLength(1);
    expect(JSON.stringify(fixture.warnings)).not.toContain('synthetic-sensitive');
    expect(fixture.usageWrites).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

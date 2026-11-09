import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { QualifiedConnectedAccountServiceRefSchema, QualifiedConnectedAccountServiceListV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';
import { admitRequesterSessionBootstrap } from './requesterSessionCredentials';
import { createPendingResetStartRecoveryPorts } from '../connectedServices/usageLimitRecovery/createPendingResetStartRecoveryPorts';

it.each(['refresh', 'quota', 'reset', 'reset_release'] as const)('retains the admitted requester lifetime through %s Home I/O', async loop => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-loop-cancellation-'));
  const channel = await createRequesterCurrentnessSocketHarness();
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
  const releases: (() => void)[] = [];
  let observedSignal: AbortSignal | undefined;
  let activeReads = 0;
  let cancelledReads = 0;
  let inventoryReads = 0;
  let resetReadStarted = false;
  let repeatedAuthorityReads = 0;
  const resetRead = loop === 'reset' || loop === 'reset_release';
  const source = { ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'account' }, bindingKind: 'account' as const };
  const recordKey = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account', quotaScope: 'account' } as const;
  const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
    providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 500, fetchedAtMs: 500,
    staleAfterMs: 1_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] };
  const reset = { source, recordId: snapshot.recordId, meterId: 'window', witness: { id: 'history', observedAtMs: 500 } };
  const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 500, staleAfterMs: 1_000, status: 'ok' }, sources: [source] };
  // Home HTTP and server feature HTTP are the only substituted boundaries.
  // Requester admission, publication, purpose inventory and both loops are real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
    const path = new URL(url).pathname;
    if (resetRead && path.endsWith('/pending')) {
      // Loss of the notification channel does not cancel an admitted finite read.
      if (loop === 'reset') { await channel.disconnect(); resetReadStarted = true; }
      return { status: 200, data: { pending: [{ localId: 'pending', status: 'queued',
        requestedAction: PendingRequestedActionV1Schema.parse({ v: 1, kind: 'reset_start', reset }) }] } };
    }
    if (resetRead && path.endsWith('/history')) return { status: 200, data: {
      entries: [{ id: 'history', observedAtMs: 500, record }], nextCursor: null } };
    if (resetRead && path.endsWith('/sources/resolve')) return { status: 200, data: {
      source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 500, staleAfterMs: 1_000 } };
    if (resetRead && path.endsWith('/record')) return { status: 200, data: record };
    if (path === '/v4/connect/qualified/accounts') {
      // Startup hydration is awaited before the loop exists. Hold only the
      // loop's own purpose inventory, identified by its published HTTP purpose.
      if (Object.entries(config?.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-happier-request-purpose')?.[1] === 'connected-accounts:requester-coordinator') {
        inventoryReads++;
        activeReads++;
        observedSignal = config?.signal instanceof AbortSignal ? config.signal : undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { cancelledReads++; reject(observedSignal?.reason); };
            const release = () => { observedSignal?.removeEventListener('abort', abort); resolve(); };
            releases.push(release);
            observedSignal?.addEventListener('abort', abort, { once: true });
            if (observedSignal?.aborted) abort();
          });
        } finally { activeReads--; }
      }
      const query = new URL(url).searchParams;
      return { status: 200, data: query.has('services')
        ? { services: parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceListV4Schema, query.get('services')), accounts: [] }
        : { service: parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, query.get('service')), accounts: [] } };
    }
    if (path.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
    if (path.endsWith('/currentness')) {
      if (resetReadStarted) { repeatedAuthorityReads++; throw new Error('Unexpected finite-wake authority re-read'); }
      return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    }
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/changes') return { status: 200, data: {
      changes: [], nextCursor: Number(config?.params?.after ?? 0),
    } };
    if (path === '/v2/sessions/bob-session') return { status: 200, data: { session: createSessionRecordFixture({
      id: 'bob-session', ownerAccountId: 'bob', encryptionMode: 'plain', share: null, dataEncryptionKey: null,
      metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
    }) } };
    return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
  });
  const features = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(
    FeaturesResponseSchema.parse({ features: { connectedServices: { enabled: true, quotas: { enabled: true } } }, capabilities: {} }),
  ), { status: 200, headers: { 'content-type': 'application/json' } }));
  const post = resetRead ? vi.spyOn(axios, 'post').mockImplementation(async url => {
    if (!String(url).endsWith('/v2/pending/reset-starts/read')) throw new Error('Unexpected reset HTTP mutation');
    return { status: 200, data: { entries: [] } };
  }) : undefined;
  resetServerFeaturesClientForTests();
  let requester: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  let plugins: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let dispose: Promise<void> | undefined;
  let releaseBootstrap: (() => Promise<void>) | undefined;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: { token: 'alice', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => requester, resolveQualifiedConnectedAccountV4Support: () => 'advertised' });
    // The real daemon publishes its declaration registry before coordinators
    // consume it. No plugin callback is needed for the held inventory read.
    plugins = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
      controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    const admitted = await admitRequesterSessionBootstrap({
      bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token } }, existingSessionId: 'bob-session',
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true },
    });
    if (!admitted) throw new Error('Missing real requester admission');
    releaseBootstrap = admitted.cleanupOnFailure;
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => true);
    requester = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug() {}, info() {}, warn() {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: loop === 'refresh' ? '1' : '0',
          HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: loop === 'quota' ? '1' : '0',
          HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED: '0',
        }, resolveQualifiedConnectedAccountPeerClass: () => 'advertised_v4',
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator },
    });
    expect(requester).not.toBeNull();
    if (resetRead) {
      const caller = new AbortController();
      const released: string[] = [];
      const recovery = createPendingResetStartRecoveryPorts({ credentials: { token: 'alice', encryption: null }, machineId: 'machine',
        isCurrent: () => !caller.signal.aborted, resolveRequesterSessionRuntimeContext: async () => requester,
        releaseRequesterSessionRuntimeContext: async () => {},
        // Installed Machine socket transport is the boundary; requester admission and reads stay real.
        release: async demand => {
          released.push(demand.localId);
          await channel.disconnect(); resetReadStarted = true;
        }, onError: error => { throw error; } });
      await recovery.withSession('bob-session', async session => {
        expect(await session.read()).toEqual([{ localId: 'pending', reset }]);
        expect(await session.readWitness(reset)).toEqual(snapshot);
        expect(await session.readCurrent(reset)).toEqual(snapshot);
        if (loop === 'reset_release') await session.release({ localId: 'pending', reset });
      }, caller.signal);
      expect(caller.signal.aborted).toBe(false);
      expect(repeatedAuthorityReads).toBe(0);
      expect(released).toEqual(loop === 'reset_release' ? ['pending'] : []);
      return;
    }
    await vi.waitFor(() => expect(activeReads).toBe(1));
    expect(inventoryReads).toBe(1);
    let retired = false;
    dispose = requester!.dispose().then(() => { retired = true; });
    await vi.waitFor(() => expect(retired, 'Retirement must settle after abort without releasing Home I/O').toBe(true));
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(cancelledReads).toBe(1);
    expect(activeReads).toBe(0);
    expect(inventoryReads).toBe(1);
    expect(await requester!.isCurrent()).toBe(false);
    expect(requester!.dispose()).toBe(requester!.dispose());
  } finally {
    for (const release of releases) release();
    try { await dispose; await requester?.dispose(); await releaseBootstrap?.(); }
    finally {
      try { await host?.dispose(); await plugins?.dispose(); }
      finally {
        get.mockRestore(); features.mockRestore(); post?.mockRestore(); resetServerFeaturesClientForTests();
        await channel.close(); await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

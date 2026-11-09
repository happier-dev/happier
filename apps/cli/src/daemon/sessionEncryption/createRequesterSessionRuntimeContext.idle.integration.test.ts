import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildConnectedServicesAccountChangeV1, type ChangeEntry } from '@happier-dev/protocol/changes';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { logger } from '@/ui/logger';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import type { TrackedSession } from '../types';
import { admitRequesterSessionBootstrap } from './requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';

it('publishes one requester inventory invalidation per Account change and no currentness cycles during settled five-minute windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-requester-idle-'));
  const channel = await createRequesterCurrentnessSocketHarness();
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'idle-account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
  const sessionId = 'idle-session';
  const home = 'https://requester-idle.test';
  const service = { pluginId: 'happier.service.email', localId: 'email-imap-smtp' };
  let changes: ChangeEntry[] = [];
  let authorityReads = 0;
  // Home HTTP and the real loopback Socket.IO endpoint are the substituted boundaries.
  vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/profile')) { authorityReads++; return { status: 200, data: { id: 'idle-account' } }; }
    if (path.endsWith('/currentness')) {
      authorityReads++;
      return { status: 200, data: { mode: 'plain', version: 1,
        updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
    }
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
      dataEncryptionKey: null, share: null,
    }) } };
    if (path === '/v2/changes') {
      const after = Number(config?.params?.after ?? 0);
      return { status: 200, data: { changes: changes.filter(change => change.cursor > after),
        nextCursor: changes.at(-1)?.cursor ?? after } };
    }
    return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
  });
  const diagnostic = vi.spyOn(logger, 'debug');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
    features: { connectedServices: { enabled: true, quotas: { enabled: true } } }, capabilities: {},
  })), { status: 200, headers: { 'content-type': 'application/json' } }));
  resetServerFeaturesClientForTests();
  const refresh = vi.spyOn(ConnectedServiceRefreshCoordinator.prototype, 'tickOnce');
  const quotas = vi.spyOn(ConnectedServiceQuotasCoordinator.prototype, 'tickOnce');
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
  let admission: Awaited<ReturnType<typeof admitRequesterSessionBootstrap>> = null;
  const settle = async () => {
    let count: number;
    do {
      await vi.advanceTimersByTimeAsync(0);
      const calls = [...refresh.mock.results, ...quotas.mock.results];
      count = calls.length;
      await Promise.all(calls.filter(result => result.type === 'return').map(result => result.value));
      await vi.advanceTimersByTimeAsync(0);
    } while (refresh.mock.calls.length + quotas.mock.calls.length !== count);
  };
  const invalidations = () => diagnostic.mock.calls.filter(([event]) => event === '[ConnectedAccounts] inventory invalidated').length;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'idle-home', serverHttpBaseUrl: home, machineId: 'machine', custodianAccountId: 'alice',
      connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      credentials: { token: 'custodian-fixture', encryption: null }, registry, trackedSessions, getRequester: () => runtime,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    admission = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester',
      credentials: { token, encryption: null } }, existingSessionId: sessionId,
      boundary: { serverId: 'idle-home', serverHttpBaseUrl: home, happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'idle-account', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true } });
    if (!admission) throw new Error('Requester admission unavailable');
    admission.admitted.bindRuntimeMachineAdmissionCurrentness(async () => true);
    await channel.settleTransport();
    vi.useFakeTimers();
    runtime = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap: admission.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'idle-runtime', happyHomeDir: directory,
        logger: { debug() {}, info() {}, warn() {} }, processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '1',
          HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1', HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Requester runtime unavailable');
    await settle();
    expect(runtime.connectedServiceRefreshCoordinator).not.toBeNull();
    expect(runtime.connectedServiceQuotasCoordinator).not.toBeNull();
    const currentnessRows = () => diagnostic.mock.calls.filter(([event]) => event === '[PluginExec] Requester currentness phase')
      .map(([, row]) => row);
    expect(currentnessRows()).toHaveLength(0);
    diagnostic.mockClear();
    await runtime.sessionFollowRuleCache.read();
    expect(currentnessRows()).toHaveLength(0);
    diagnostic.mockClear();
    expect(await runtime.isCurrent()).toBe(true);
    expect(currentnessRows()).toHaveLength(0);
    authorityReads = 0;
    diagnostic.mockClear();
    const before = invalidations();
    await vi.advanceTimersByTimeAsync(300_000);
    await settle();
    expect(authorityReads).toBe(0);
    expect(currentnessRows()).toHaveLength(0);
    expect(invalidations()).toBe(before);
    // Unrelated Account arrivals do not invalidate Connected Accounts.
    for (let cursor = 1; cursor <= 10; cursor++) {
      changes.push({ cursor, kind: 'session', entityId: 'another-session', changedAt: cursor });
      await channel.hintAccountChange(cursor);
    }
    await settle();
    expect(invalidations()).toBe(before);
    changes.push({ ...buildConnectedServicesAccountChangeV1(service), cursor: 11, changedAt: 11 });
    await channel.hintAccountChange(11);
    await vi.waitFor(() => expect(invalidations()).toBeGreaterThan(before));
    await settle();
    expect(invalidations() - before).toBe(1);
    expect(currentnessRows()).toHaveLength(0);
    authorityReads = 0;
    const afterChange = invalidations();
    const afterChangeCurrentness = currentnessRows().length;
    await vi.advanceTimersByTimeAsync(300_000);
    await settle();
    expect(authorityReads).toBe(0);
    expect(currentnessRows()).toHaveLength(afterChangeCurrentness);
    expect(invalidations()).toBe(afterChange);
    for (let duplicate = 0; duplicate < 10; duplicate++) await channel.hintAccountChange(11);
    await settle();
    expect(authorityReads).toBe(0);
    expect(currentnessRows()).toHaveLength(afterChangeCurrentness);
    expect(invalidations()).toBe(afterChange);
    changes.push({ ...buildConnectedServicesAccountChangeV1(), cursor: 12, changedAt: 12 });
    await channel.hintAccountChange(12);
    await vi.waitFor(() => expect(invalidations() - afterChange).toBe(1));
    await settle();
    await runtime.dispose();
    runtime = null;
    // Disposal closes the requester channel; asking that retired socket for a
    // delivery acknowledgement would wait for a peer that no longer exists.
    expect(channel.clients.every(client => !client.connected)).toBe(true);
  } finally {
    await runtime?.dispose();
    await admission?.cleanupOnFailure();
    vi.useRealTimers();
    await host?.dispose();
    await channel.close();
    resetServerFeaturesClientForTests();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

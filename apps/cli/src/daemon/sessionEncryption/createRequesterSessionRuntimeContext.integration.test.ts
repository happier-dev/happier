import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createProviderAccountUsagePersistenceScheduler, flushProviderAccountUsagePersistenceForTrackedSessions } from '../connectedServices/accountUsage/persistence';
import { fetchConnectedServiceProjectionForSession } from '../connectedServices/accountGroups/generation/connectedServiceProjectionSnapshot';
import { registerExecutionRunConnectedServicesTarget } from '../connectedServices/runs/executionRunMaterialization';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { admitRequesterSessionBootstrap, assertRequesterSessionAccountContextCurrent } from './requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import { createPendingResetStartRecoveryPorts } from '../connectedServices/usageLimitRecovery/createPendingResetStartRecoveryPorts';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
it.each(['refresh', 'untracked-lifetime', 'profile-unavailable'] as const)('keeps requester %s isolated from active Alice', async (surface) => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-profiles-'));
  let current = true;
  let revision = 2;
  let holdRows = false;
  let releaseRows: (() => void) | undefined;
  const profileReads: string[] = [];
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'bob-profile', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'legacy', profile: { id: 'bob-profile', name: 'Bob native', createdAt: 1, updatedAt: 2 } } });
  const aliceCredentials = { token: 'alice', encryption: null };
  await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(aliceCredentials) });
  });
  const alice = getActiveAccountSettingsSnapshot();
  // HTTP and admitted Machine access are the boundaries. Both Account custody
  // owners, the full Profile pager and requester runtime stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
    const path = new URL(url).pathname;
    const profilePath = path.startsWith('/v1/account/entity-rows/profiles');
    if (profilePath) {
      expect(config?.headers?.Authorization).toBe('Bearer bob');
      expect(new URL(url).origin).toBe('https://bob-home.test');
      profileReads.push(path);
      if (surface === 'profile-unavailable') return { status: 404, data: { error: 'not_found' } };
    }
    if (path.endsWith('/profile')) return { status: 200, data: { id: 'bob' } };
    if (path.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path.endsWith('/profiles/reference-guard')) return { status: 200, data: { status: 'ready', revision } };
    if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path.endsWith('/entity-rows/profiles')) {
      if (holdRows) await new Promise<void>(resolve => { releaseRows = resolve; });
      return { status: 200, data: { status: 'listed',
        rows: [{ id: record.id, revision, content: { t: 'plain', v: record } }], nextCursor: null, complete: true,
        diagnostics: [], referenceGuardRevision: revision, transferControl: { status: 'absent' } } };
    }
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path === '/v4/connect/qualified/accounts') return { status: 200, data: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accounts: [] } };
    return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
  });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: aliceCredentials, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob' } },
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
    // Admission captures the real settings/cache lifetime after daemon startup.
    expect(admitted.admitted.accountSettingsContext.scopeKey).toBe(resolveAccountSettingsScopeKey(admitted.admitted.credentials));
    runtime = await createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    if (surface === 'untracked-lifetime') {
      // This actual invocation-local Account runtime must be released on denial.
      const untracked = runtime;
      await expect(assertRequesterSessionAccountContextCurrent({ expected: null,
        resolveCurrent: async () => untracked, readTrackedContext: () => null }))
        .rejects.toThrow('requester_session_not_current');
      await expect(untracked.qualifiedConnectedAccountApi.listAccounts({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      })).rejects.toThrow('requester_account_context_unavailable');
      return;
    }
    if (surface === 'profile-unavailable') {
      // The same requester freshness port admits launches without a Profile.
      // An unavailable Profile domain must remain typed and runtime-closed,
      // without changing successful Account Settings freshness into failure.
      expect(await runtime.refreshAccountSettings()).toBe(true);
      expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
        profileCatalog: { status: 'unavailable', reason: 'unsupported' } });
      await expect(runtime.readAccountLaunchProfiles()).rejects.toMatchObject({ code: 'authoring_memory_unavailable' });
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      return;
    }
    expect(await runtime.refreshAccountSettings()).toBe(true);
    expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
      profileCatalog: { status: 'ready', source: 'destination', records: [{ record, revision: 2 }] } });
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    revision = 3;
    expect(await runtime.refreshAccountSettings()).toBe(true);
    expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
      profileCatalog: { status: 'ready', records: [{ revision: 3 }] } });
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    expect(profileReads).toContain('/v1/account/entity-rows/profiles');
    holdRows = true;
    const retiredRead = runtime.refreshAccountSettings();
    await vi.waitFor(() => expect(releaseRows).toBeDefined());
    current = false;
    releaseRows?.();
    expect(await retiredRead).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
  } finally {
    releaseRows?.();
    try {
      await runtime?.dispose();
    } finally {
      try {
        await host?.dispose();
      } finally {
        get.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

it.each(['generation', 'usage', 'reconnect', 'run_custody'] as const)('keeps requester %s effects under Bob Home and credentials without consuming Alice authority', async (surface) => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-usage-'));
  let current = true;
  // Account admission, encryption mode and durable usage writes are genuine HTTP boundaries.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => ({ status: 200,
    data: url.endsWith('/profile') ? { id: config?.headers?.Authorization === 'Bearer alice' ? 'alice' : 'bob',
      connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }],
        groups: [{ groupId: 'main', activeProfileId: 'work', generation: config?.headers?.Authorization === 'Bearer alice' ? 1 : 2,
          memberProfileIds: ['work'] }] }],
      connectedServiceCredentialRevisionsV1: [{ serviceId: 'openai-codex', profileId: 'work', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }] }
      : url.endsWith('/currentness')
      ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : url.endsWith('/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : { content: { t: 'plain', v: {} }, version: 1 },
  }));
  const writes: Array<{ url: string; token: unknown; data: unknown }> = [];
  let bobUnavailable = surface === 'reconnect';
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
    if (bobUnavailable && config?.headers?.Authorization === 'Bearer bob') return { status: 503, data: null };
    writes.push({ url, token: config?.headers?.Authorization, data });
    return { status: 200, data: { success: true, source: { status: 'linked' } } };
  });
  const alice = createProviderAccountUsagePersistenceScheduler({ credentials: { token: 'alice', encryption: null },
    api: { getAccountEncryptionMode: async () => 'plain' }, now: () => Date.now() });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  const registry = new ConnectedServiceRuntimeRegistry();
  const trackedSessions = new Map<number, TrackedSession>();
  try {
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: { token: 'alice', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob' } },
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
    runtime = await createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    if (surface === 'run_custody') {
      const exactRuntime = runtime;
      const registration = { runKey: 'cold-bob-run', runnerPid: process.pid, agentId: 'codex' as const,
        materializationKey: 'cold-bob-run', connectedServicesBindingsRaw: {}, connectedServiceSelectionsEnv: {}, sessionId: 'cold-bob' };
      const input = { registry, registration, resolveSessionAccountContext: async () => exactRuntime,
        assertSessionAccountCurrent: async () => { if (!await exactRuntime.isCurrent()) throw new Error('requester_session_not_current'); } };
      await registerExecutionRunConnectedServicesTarget(input);
      expect(registry.getRunTargetByRunKey('cold-bob-run')?.requesterWorkAttributionV1).toEqual(exactRuntime.bootstrap.attribution);
      expect(runtime.connectedServiceRuntimeRegistry?.getRunTargetByRunKey('cold-bob-run')?.sessionId).toBe('cold-bob');
      current = false;
      await expect(registerExecutionRunConnectedServicesTarget({ ...input, registration: { ...registration,
        runKey: 'retired-bob-run', materializationKey: 'retired-bob-run' } })).rejects.toThrow('requester_session_not_current');
      expect(registry.getRunTargetByRunKey('retired-bob-run')).toBeNull();
      expect(registry.unregisterRunKey('cold-bob-run')?.materializationKey).toBe('cold-bob-run');
      expect(registry.getRunTargetByRunKey('cold-bob-run')).toBeNull();
      await runtime.dispose();
      await expect(registerExecutionRunConnectedServicesTarget({ ...input, registration: { ...registration,
        runKey: 'disposed-bob-run', materializationKey: 'disposed-bob-run' } })).rejects.toThrow('requester_session_not_current');
      expect(registry.getRunTargetByRunKey('disposed-bob-run')).toBeNull();
      return;
    }
    if (surface === 'generation') {
      const exactRuntime = runtime;
      const input = { token: 'alice', sessionId: 'bob-session', resolveSessionAccountContext: async () => exactRuntime,
        assertSessionAccountCurrent: async () => { if (!await exactRuntime.isCurrent()) throw new Error('requester_session_not_current'); } };
      const projection = await fetchConnectedServiceProjectionForSession(input);
      expect(projection.snapshot.groups).toEqual([{ serviceId: 'happier.agent.codex/openai-codex', groupId: 'main', activeProfileId: 'work', generation: 2 }]);
      expect(projection.requester).toBe(true);
      const bobProfileUrls = new Set(get.mock.calls.filter(([url, config]) => String(url).endsWith('/profile')
        && config?.headers?.Authorization === 'Bearer bob').map(([url]) => url));
      expect([...bobProfileUrls]).toEqual(['https://bob-home.test/v1/account/profile']);
      current = false;
      await expect(fetchConnectedServiceProjectionForSession(input)).rejects.toThrow('requester_session_not_current');
      const owned = await runWithServerHttpBaseUrl('https://alice-home.test', () => fetchConnectedServiceProjectionForSession({ token: 'alice' }));
      expect(owned.snapshot.groups[0]?.generation).toBe(1);
      expect(owned.requester).toBe(false);
      return;
    }
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-bob', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'provider-bob' }, observedAtMs: 1_000,
      fetchedAtMs: 1_000, staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data', meters: [] };
    const targets = [{ source: { ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
      bindingKind: 'account' as const }, expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: 'cfg-current' }];
    await runtime.providerAccountUsagePersistence.recordInBandSnapshot(snapshot, { targets });
    await runtime.providerAccountUsagePersistence.flush(1_000);
    if (surface === 'reconnect') {
      // Flush the retained failure once while transport is still down; the canonical
      // retry owner then parks it until reconnect, rather than an incidental timer.
      await runtime.providerAccountUsagePersistence.flush(1_000);
      expect(writes).toEqual([]);
      bobUnavailable = false;
      const exactRuntime = runtime;
      const reconnect = () => flushProviderAccountUsagePersistenceForTrackedSessions({ ownedScheduler: alice,
        trackedSessions: [{ happySessionId: 'bob-session' }, { happySessionId: 'bob-session' }],
        resolveSessionAccountContext: async () => exactRuntime, timeoutMs: 1_000 });
      await runWithServerHttpBaseUrl('https://alice-home.test', reconnect);
      expect(writes).toEqual([{ url: 'https://bob-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer bob',
        data: expect.objectContaining({ snapshot }) }]);
      current = false;
      await runtime.providerAccountUsagePersistence.recordInBandSnapshot({ ...snapshot, fetchedAtMs: 2_000 }, { targets });
      await runtime.providerAccountUsagePersistence.flush(1_000);
      await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
        await alice.recordInBandSnapshot(snapshot, { targets });
        await reconnect();
      });
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual({ url: 'https://alice-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer alice',
        data: expect.objectContaining({ snapshot }) });
      return;
    }
    expect(writes).toEqual([{ url: 'https://bob-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer bob',
      data: expect.objectContaining({ source: targets[0].source, snapshot, payloadMode: 'plain_json_v1' }) }]);
    current = false;
    await runtime.providerAccountUsagePersistence.recordInBandSnapshot({ ...snapshot, fetchedAtMs: 2_000 }, { targets });
    await runtime.providerAccountUsagePersistence.flush(1_000);
    expect(writes).toHaveLength(1);
    await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
      await alice.recordInBandSnapshot(snapshot, { targets });
      await alice.flush(1_000);
    });
    expect(writes[1]).toEqual({ url: 'https://alice-home.test/v4/connect/qualified/provider-account-usage', token: 'Bearer alice',
      data: expect.objectContaining({ snapshot }) });
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      try {
        await host?.dispose();
      } finally {
        alice.dispose(); get.mockRestore(); post.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});


it.each(['retired', 'pending_release'] as const)('keeps requester runtime %s under its canonical authority', async surface => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-runtime-'));
  let holdCurrentness = false;
  let enterCurrentness: (() => void) | undefined;
  let releaseCurrentness: (() => void) | undefined;
  let delayReleaseProbe = false;
  const currentnessEntered = new Promise<void>(resolve => { enterCurrentness = resolve; });
  // HTTP admission/profile/settings is the boundary; all Account owners and runtime composition are real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (delayReleaseProbe && url.endsWith('/currentness')) vi.setSystemTime(2_000);
    if (holdCurrentness && url.endsWith('/currentness')) {
      enterCurrentness?.();
      await new Promise<void>(resolve => { releaseCurrentness = resolve; });
    }
    return { status: 200,
    data: url.endsWith('/v2/sessions/bob-session') ? { session: createSessionRecordFixture({
      id: 'bob-session', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
      dataEncryptionKey: null, share: null,
    }) } : url.endsWith('/profile') ? { id: 'bob' } : url.endsWith('/currentness')
      ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : { content: { t: 'plain', v: {} }, version: 1 },
    };
  });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: { token: 'alice', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob' } },
      existingSessionId: 'bob-session',
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => true);
    runtime = await createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    expect(await runtime.bootstrap.isCurrent()).toBe(true);
    if (surface === 'pending_release') {
      const captured = runtime;
      const emittedAt: number[] = [];
      const ports = createPendingResetStartRecoveryPorts({ credentials: { token: 'alice', encryption: null }, machineId: 'machine',
        isCurrent: () => true, resolveRequesterSessionRuntimeContext: async () => captured,
        releaseRequesterSessionRuntimeContext: context => context.dispose(),
        // Installed Machine transport is the boundary; the scoped requester adapter remains real.
        release: async () => { emittedAt.push(Date.now()); }, onError: error => { throw error; } });
      vi.useFakeTimers(); vi.setSystemTime(1_000);
      await ports.withSession('bob-session', async session => {
        expect(await session.isCurrent()).toBe(true);
        // The caller's final authority check and readiness decision just settled.
        // A further HTTP probe would postpone the Machine effect beyond the window.
        delayReleaseProbe = true;
        await session.release({ localId: 'pending', reset: {
          source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' },
          recordId: buildProviderAccountUsageRecordId({ providerId: 'test', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' }),
          meterId: 'window', witness: { id: 'history', observedAtMs: 500 },
        } });
      });
      expect(emittedAt).toEqual([1_000]);
      expect(await captured.isCurrent()).toBe(false);
      return;
    }
    holdCurrentness = true;
    const checking = runtime.isCurrent();
    await currentnessEntered;
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    releaseCurrentness?.();
    expect(await checking).toBe(false);
    const before = get.mock.calls.length;
    await expect(assertRequesterSessionAccountContextCurrent({ expected: runtime,
      resolveCurrent: async () => runtime, readTrackedContext: () => runtime })).rejects.toThrow('requester_session_not_current');
    await expect(runtime.qualifiedConnectedAccountApi.listAccounts({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }))
      .rejects.toThrow('requester_account_context_unavailable');
    expect(await runtime.refreshAccountSettings()).toBe(false);
    expect(() => runtime.readAccountSettingsSnapshot()).toThrow('requester_account_context_unavailable');
    expect(get.mock.calls.length).toBe(before);
  } finally {
    releaseCurrentness?.();
    vi.useRealTimers();
    try {
      await runtime?.dispose();
    } finally {
      try {
        await host?.dispose();
      } finally {
        get.mockRestore(); await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

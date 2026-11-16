import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Runtime consumers below are static imports; install their transport boundary before evaluation.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { handleEphemeralSocketUpdate } from '@/sync/engine/socket/socket';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildConnectedAccountCatalogPhysicalKeyV1, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { REMOTE_HOST_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { buildPromptLibraryPhysicalKeyV1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { observeProviderCatalog, refreshProviderCatalog, resetProviderCatalogEngineForTests } from './providerCatalogEngine';
import { observeConnectedAccountCatalog, refreshConnectedAccountCatalog, resetConnectedAccountCatalogEngineForTests } from './connectedAccountCatalogEngine';
import { observeConnectedMetadataCatalog, refreshConnectedMetadataCatalog, resetConnectedMetadataCatalogEngineForTests } from './connectedMetadataCatalogEngine';
import { observeRemoteHostCatalog, refreshRemoteHostCatalog, resetRemoteHostCatalogEngineForTests } from './remoteHostCatalogEngine';
import { getProviderCatalogSnapshot, resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { getConnectedAccountCatalogValue, resetConnectedAccountCatalogSnapshotsForTests } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { getRemoteHostCatalogSnapshot, resetRemoteHostCatalogSnapshotsForTests } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { observePromptLibraryCatalog, refreshPromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } from './promptLibraryCatalogEngine';
import { getAcknowledgedPromptLibraryCatalogValue, getPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests,
    subscribePromptLibraryCatalogSnapshots } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { getStorage } from '@/sync/domains/state/storage';
import { observeProfileCatalog, resetProfileCatalogEngineForTests } from './profileCatalogEngine';
import { getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { observeAcpCatalog, refreshAcpCatalog, resetAcpCatalogEngineForTests } from './acpCatalogEngine';
import { getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1, readFreshAcpCatalogSourceV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import type { InvalidateSync } from '@/utils/sessions/sync';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    resetProviderCatalogEngineForTests();
    resetConnectedAccountCatalogEngineForTests();
    resetConnectedMetadataCatalogEngineForTests();
    resetRemoteHostCatalogEngineForTests();
    resetPromptLibraryCatalogEngineForTests();
    resetProfileCatalogEngineForTests();
    resetProviderCatalogSnapshotsForTests();
    resetConnectedAccountCatalogSnapshotsForTests();
    resetRemoteHostCatalogSnapshotsForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    resetProfileCatalogSnapshotsForTests();
    await disconnectActiveServerConnection();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
});

describe('private catalog Account-change admission', () => {
    it('refreshes a consumed legacy ACP Settings key through the real feed when no private row exists', async () => {
      const accountId = 'catalog-legacy-acp-source';
      let settingsVersion = 7;
      let rawSettings: Record<string, unknown> = {};
      let cursor = 0;
      const reads = new Map<string, number>();
      const restored = await restoreServerAccountForTest({
        serverUrl: 'https://catalog-legacy-acp-source.example.test',
        accountId,
        request: async (input, init) => {
          const url = new URL(String(input));
          const path = url.pathname;
          reads.set(path, (reads.get(path) ?? 0) + 1);
          if (path === '/v1/features' || path === '/v1/features/authenticated')
            return Response.json(createRootLayoutFeaturesResponse());
          if (path === '/v1/account/encryption')
            return Response.json({ mode: 'plain', updatedAt: 0 });
          if (path === '/v1/account/encryption/currentness')
            return Response.json(
              createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }),
            );
          if (path === '/v2/account/settings')
            return Response.json({
              version: settingsVersion,
              content: { t: 'plain', v: rawSettings },
            });
          if (path === '/v1/account/profile')
            return Response.json({ ...profileDefaults, id: accountId });
          if (path === '/v1/account/entity-rows/acp')
            return Response.json({ status: 'absent' });
          if (path === '/v2/cursor')
            return Response.json({ cursor, changesFloor: 0 });
          if (path === '/v2/changes')
            return Response.json({
              changes:
                cursor > Number(url.searchParams.get('after'))
                  ? [
                      {
                        kind: 'account',
                        entityId: 'self',
                        cursor,
                        changedAt: cursor,
                        hint: { settingsVersion },
                      },
                    ]
                  : [],
              nextCursor: cursor,
            });
          if (path === '/v1/artifacts') return Response.json([]);
          if (path === '/v1/friends' || path === '/v1/friends/requests')
            return Response.json({ friends: [], requests: [] });
          return createEmptyAccountBootstrapHttpResponse(path, init);
        },
      });
      const scope = { serverId: restored.serverId, accountId };
      const sync = getSyncSingleton();
      await sync.awaitBootstrapForegroundAcquisition();
      await sync.resumeSync('changes-catch-up');
      const release = observeAcpCatalog(scope);
      try {
        await refreshAcpCatalog(scope);
        expect(getAcpCatalogSnapshot(scope)?.catalog).toMatchObject({
          status: 'ready',
          revision: 'absent',
          sourceSettingsVersion: 7,
        });
        reads.clear();
        settingsVersion++;
        rawSettings = { acpCatalogSettingsV1: { v: 2, backends: [] } };
        expect(readFreshAcpCatalogSourceV1(rawSettings).status).toBe('ready');
        cursor++;
        await sync.resumeSync('changes-catch-up');
        await vi.waitFor(() =>
          expect(getAcpCatalogSnapshot(scope)?.catalog).toMatchObject({
            status: 'ready',
            revision: 'absent',
            sourceSettingsVersion: 8,
          }),
        );
        expect(reads.get('/v1/account/entity-rows/acp')).toBe(1);
        // Sync applies Settings and the absent-row catalog reads its real source.
        expect(reads.get('/v2/account/settings')).toBe(2);
        expect(reads.get('/v2/account/settings/history') ?? 0).toBe(0);
        console.info(
          'SELFWAKE_LEGACY_SOURCE',
          JSON.stringify(Object.fromEntries(reads)),
        );
      } finally {
        release();
        await restored.dispose();
      }
    });
    it('prompt currentness follows relevant and coarse wakes, not unrelated known kinds', async () => {
        const domain = 'prompt';
        const accountId = `catalog-kind-wakes-${domain}`;
        let currentnessGets = 0;
        let catalogGets = 0;
        let settingsGets = 0;
        let heldSkillReply: Promise<Response> | null = null;
        let releaseSkillReply = () => {};
        let skillRowReads = 0;
        let stopRecording = () => {};
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path.startsWith('/v1/account/entity-rows/prompt-library')) catalogGets++;
            if (path === '/v2/account/settings') settingsGets++;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') {
                currentnessGets++;
                return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            }
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            const promptRows = PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
                content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } }));
            if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed', rows: promptRows });
            if (path === '/v1/account/entity-rows/prompt-library/skill-rules') {
                skillRowReads++;
                if (heldSkillReply) return heldSkillReply;
                return Response.json({ status: 'present', ...promptRows.find(row => row.key === 'skill-rules') });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await disconnectActiveServerConnection();
        const home = await upsertAndActivateServer({ serverUrl: `https://${domain.toLowerCase()}-kind-wakes.example.test`, name: domain });
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await restoreConnectionToActiveServer(credentials);
        await getSyncSingleton().awaitBootstrapForegroundAcquisition();
        const scope = { serverId: home.id, accountId };
        getStorage().setState({ profileScope: scope, settingsScope: scope });
        await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(7));
        const owner = {
            observe: () => observePromptLibraryCatalog(scope), refresh: () => refreshPromptLibraryCatalog(scope),
            snapshot: () => getPromptLibraryCatalogSnapshot(scope),
        };
        const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
        let release = owner.observe();
        try {
            await owner.refresh();
            await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ catalog: { status: 'ready' } }));
            await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ catalog: { cleanup: { status: 'complete' } } }));
            await settle();
            const baseline = currentnessGets;
            const baselineCatalogGets = catalogGets;
            const baselineSettingsGets = settingsGets;
            const retained = owner.snapshot();
            for (let navigation = 0; navigation < 20; navigation++) {
                release();
                release = owner.observe();
                await settle();
            }
            expect(currentnessGets - baseline).toBe(0);
            expect(catalogGets - baselineCatalogGets).toBe(0);
            expect(settingsGets - baselineSettingsGets).toBe(0);
            expect(owner.snapshot()).toBe(retained);
            for (let index = 0; index < 1_000; index++) publishHomeAccountChange(home.id, [`session-${index}`], {
                source: 'catch-up-pending', changeKinds: ['session'],
            });
            publishHomeAccountChange(home.id, undefined, { source: 'catch-up-pending', changeKinds: ['session'] });
            publishHomeAccountChange(home.id, undefined, { changeKinds: ['session'] });
            publishHomeAccountChange(home.id, undefined, { source: 'catch-up-pending', changeKinds: ['savedSecretResource'] });
            publishHomeAccountChange(home.id, ['session-record:visual-record'], { source: 'catch-up-pending', changeKinds: ['account'],
                sessionSystemRecords: [{ sessionId: 'session-one', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } }] });
            await settle();
            expect(currentnessGets - baseline).toBe(0);
            expect(owner.snapshot()).toBe(retained);
            for (const changeKinds of [['account'], undefined, [], ['future-domain'], ['kv']] as const) {
                const before = currentnessGets;
                publishHomeAccountChange(home.id, undefined, { source: 'catch-up-pending', changeKinds,
                    ...(changeKinds?.[0] === 'future-domain' ? { accountSettingsAffects: false } : {}) });
                await vi.waitFor(() => expect(currentnessGets).toBeGreaterThan(before));
                await owner.refresh();
                await settle();
                const catalog = owner.snapshot()?.catalog;
                expect(catalog?.status === 'unavailable'
                    ? { status: catalog.status, reason: catalog.reason } : { status: catalog?.status }).toEqual({ status: 'ready' });
            }
            heldSkillReply = new Promise<Response>(resolve => {
                releaseSkillReply = () => resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
            });
            const publications: string[] = [];
            stopRecording = subscribePromptLibraryCatalogSnapshots(() => {
                publications.push(getPromptLibraryCatalogSnapshot(scope)?.catalog.status ?? 'absent');
            });
            const beforeHeldRead = skillRowReads;
            const skillRuleKey = buildPromptLibraryPhysicalKeyV1('skill-rules');
            publishHomeAccountChange(home.id, [skillRuleKey], {
                entityRevisions: { [skillRuleKey]: 2 },
            });
            await vi.waitFor(() => expect(skillRowReads).toBe(beforeHeldRead + 1));
            release();
            releaseSkillReply();
            await owner.refresh();
            // The direct row publisher must not admit its canceled response,
            // even though the captured Account itself remains valid.
            expect(getAcknowledgedPromptLibraryCatalogValue(scope, 'skill-rules').revision).toBe(1);
            expect(publications).not.toContain('unavailable');
        } finally { stopRecording(); releaseSkillReply(); release(); }
    });
    it('serves repeated prompt-library uses from the held row and re-reads only after a row wake', async () => {
        const accountId = 'catalog-held-prompt-uses';
        const reads = new Map<string, number>();
        let invocationsRevision = 1;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            const counted = path.startsWith('/v1/account/entity-rows/') || path.startsWith('/v2/account/settings')
                || path === '/v1/account/encryption/currentness';
            if (counted && (init?.method ?? 'GET') === 'GET') reads.set(path, (reads.get(path) ?? 0) + 1);
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options
                .map(key => ({ key, revision: key === 'invocations' ? invocationsRevision : 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await disconnectActiveServerConnection();
        const home = await upsertAndActivateServer({ serverUrl: 'https://held-prompt-uses.example.test', name: 'held-prompt-uses' });
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await restoreConnectionToActiveServer(credentials);
        await getSyncSingleton().awaitBootstrapForegroundAcquisition();
        const scope = { serverId: home.id, accountId };
        getStorage().setState({ profileScope: scope, settingsScope: scope });
        await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(7));
        const { getCommandSuggestions } = await import('@/components/autocomplete/commandSuggestions');
        const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
        const total = () => [...reads.values()].reduce((sum, count) => sum + count, 0);
        await getCommandSuggestions(null, '/', { serverId: home.id });
        await vi.waitFor(() => expect(getPromptLibraryCatalogSnapshot(scope)).toMatchObject({ catalog: { status: 'ready', cleanup: { status: 'complete' } } }));
        await settle();
        const baseline = total();
        for (let use = 0; use < 3; use++) await getCommandSuggestions(null, '/re', { serverId: home.id });
        await settle();
        // The held catalog is current: each use reads nothing, including Settings maintenance.
        expect(total() - baseline).toBe(0);
        invocationsRevision = 2;
        const invocationsKey = buildPromptLibraryPhysicalKeyV1('invocations');
        publishHomeAccountChange(home.id, [invocationsKey], { entityRevisions: { [invocationsKey]: 2 } });
        await getCommandSuggestions(null, '/re', { serverId: home.id });
        expect(reads.get('/v1/account/entity-rows/prompt-library')).toBe(2);
        expect(getAcknowledgedPromptLibraryCatalogValue(scope, 'invocations').revision).toBe(2);
    });
    it.each(['providers', 'configurations', 'purposes', 'metadata', 'remote-hosts', 'acp'] as const)(
        '%s retains admitted authority for unrelated changes, but revalidates its own rows and Account source', async domain => {
            const accountId = `catalog-wakes-${domain}`;
            const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
            let revision = 1;
            let currentnessGets = 0;
            let feedCursor = 0;
            let feedChanges: ApiChangeEntry[] = [];
            let settingsVersion = 7;
            let settingsRaw: Record<string, unknown> = {};
            const catalogReads = new Map<string, number>();
            // Home HTTP and the disconnected socket are the only substituted boundaries.
            // Account admission, private-row readers, maintenance and publication all run.
            setRuntimeFetch(async (url, init) => {
                const requestUrl = new URL(String(url));
                const path = requestUrl.pathname;
                // A retired fixture's captured cleanup is never this Home's request or Account response.
                if (requestUrl.hostname !== `${domain}-wakes.example.test`) {
                    return Response.json({ error: 'unauthorized' }, { status: 401 });
                }
                if ((init?.method ?? 'GET') === 'GET' && (path.startsWith('/v1/account/entity-rows/') || path.startsWith('/v2/account/settings'))) {
                    catalogReads.set(path, (catalogReads.get(path) ?? 0) + 1);
                }
                if (path === '/v2/cursor')
                  return Response.json({ cursor: feedCursor, changesFloor: 0 });
                if (path === '/v2/changes')
                  return Response.json({
                    changes: feedChanges.filter(
                      (change) =>
                        Number(change.cursor) >
                        Number(new URL(String(url)).searchParams.get('after')),
                    ),
                    nextCursor: feedCursor,
                  });
                if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption/currentness') {
                    currentnessGets++;
                    return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }));
                }
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') {
                  return Response.json({
                    version: settingsVersion,
                    content: { t: 'plain', v: settingsRaw },
                  });
                }
                if (path === '/v1/artifacts') {
                    const response = artifacts.handle(`${path}${new URL(String(url)).search}`);
                    if (response) return response;
                }
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
                if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 'absent' });
                if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
                    complete: true, referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [] });
                if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed',
                    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision,
                        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) });
                if (['/v1/account/entity-rows/acp', '/v1/account/entity-rows/mcp',
                    '/v1/account/entity-rows/notification-channels'].includes(path)) return Response.json({ status: 'deleted', revision });
                if (path === '/v1/account/entity-rows/provider-connections') return Response.json({ status: 'present', revision,
                    content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } });
                for (const key of ['configurations', 'purposes'] as const) {
                    if (path === `/v1/account/entity-rows/connected-accounts/${key}`) return Response.json({ status: 'present', revision,
                        content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1(key) } });
                }
                if (path === '/v1/account/entity-rows/connected-metadata/presentation'
                    || path === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json({ status: 'present', revision,
                    content: { t: 'plain', v: { v: 1, entries: [] } } });
                if (path === '/v1/account/entity-rows/remote-hosts') return Response.json({ status: 'present', revision,
                    content: { t: 'plain', v: { v: 1, hosts: [] } } });
                return createEmptyAccountBootstrapHttpResponse(path, init) ?? Response.json({ error: 'not_found' }, { status: 404 });
            });
            await disconnectActiveServerConnection();
            const home = await upsertAndActivateServer({ serverUrl: `https://${domain}-wakes.example.test`, name: domain });
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
            await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
            await restoreConnectionToActiveServer(credentials);
            await getSyncSingleton().awaitBootstrapForegroundAcquisition();
            const sync = getSyncSingleton();
            const bootstrapQueues = sync as unknown as {
              settingsSync: InvalidateSync;
              profileSync: InvalidateSync;
              sessionsSync: InvalidateSync;
              machinesSync: InvalidateSync;
              artifactsSync: InvalidateSync;
              pluginAvailabilitySync: InvalidateSync;
              purchasesSync: InvalidateSync;
              nativeUpdateSync: InvalidateSync;
              friendsSync: InvalidateSync;
              feedSync: InvalidateSync;
              todosSync: InvalidateSync;
              automationsSync: InvalidateSync;
              accountPetsSync: InvalidateSync;
              resumeInFlight: Promise<void> | null;
            };
            await Promise.all(
              [
                bootstrapQueues.settingsSync,
                bootstrapQueues.profileSync,
                bootstrapQueues.sessionsSync,
                bootstrapQueues.machinesSync,
                bootstrapQueues.artifactsSync,
                bootstrapQueues.pluginAvailabilitySync,
                bootstrapQueues.purchasesSync,
                bootstrapQueues.nativeUpdateSync,
                bootstrapQueues.friendsSync,
                bootstrapQueues.feedSync,
                bootstrapQueues.todosSync,
                bootstrapQueues.automationsSync,
                bootstrapQueues.accountPetsSync,
              ].map((queue) => queue.awaitQueue()),
            );
            await bootstrapQueues.resumeInFlight;
            const scope = { serverId: home.id, accountId };
            const owner = domain === 'providers' ? {
                observe: () => observeProviderCatalog(scope), refresh: () => refreshProviderCatalog(scope),
                snapshot: () => getProviderCatalogSnapshot(scope),
                rowIds: [PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1],
            } : domain === 'acp' ? {
                observe: () => observeAcpCatalog(scope), refresh: () => refreshAcpCatalog(scope),
                snapshot: () => getAcpCatalogSnapshot(scope)?.catalog, rowIds: [ACP_CATALOG_ACCOUNT_ROW_KEY_V1],
            } : domain === 'metadata' ? {
                observe: () => observeConnectedMetadataCatalog(scope), refresh: () => refreshConnectedMetadataCatalog(scope),
                snapshot: () => getConnectedMetadataCatalog(scope).presentation,
                rowIds: [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1],
            } : domain === 'remote-hosts' ? {
                observe: () => observeRemoteHostCatalog(scope), refresh: () => refreshRemoteHostCatalog(scope),
                snapshot: () => getRemoteHostCatalogSnapshot(scope)?.catalog, rowIds: [REMOTE_HOST_ACCOUNT_KV_KEY_V1],
            } : {
                observe: () => observeConnectedAccountCatalog(scope, domain), refresh: () => refreshConnectedAccountCatalog(scope, domain),
                snapshot: () => getConnectedAccountCatalogValue(scope, domain), rowIds: [buildConnectedAccountCatalogPhysicalKeyV1(domain)],
            };
            if (domain === 'acp') {
                // Voice can be the first consumer and owns only a finite read,
                // not a mounted observer. Its settled admission still withdraws.
                await owner.refresh();
                expect(getAcpCatalogSnapshot(scope)?.stale).toBe(false);
                invalidateAccountEncryptionModeCache({ serverId: home.id, reason: 'transport-withdrawal' });
                expect(getAcpCatalogSnapshot(scope)?.stale).toBe(true);
            }
            let release = owner.observe();
            try {
                await owner.refresh();
                await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ status: 'ready', revision: 1 }));
                // Ready rows can precede maintenance and its final currentness proof.
                // Sync's admitted Settings hold no retained Provider/metadata root, so
                // those catalogs owe no source/history pass. Count navigation after it.
                if (domain === 'metadata') {
                    await vi.waitFor(() => expect(getConnectedMetadataCatalog(scope).cleanup).toBeUndefined());
                } else if (domain === 'providers') {
                    await vi.waitFor(() => expect(getProviderCatalogSnapshot(scope)?.catalog).not.toHaveProperty('cleanup'));
                } else if (domain === 'remote-hosts') {
                    await vi.waitFor(() => expect(getRemoteHostCatalogSnapshot(scope)?.catalog).not.toHaveProperty('cleanup'));
                } else if (domain === 'acp') {
                    await vi.waitFor(() => expect(getAcpCatalogSnapshot(scope)?.cleanup?.status).toBe('complete'));
                }
                let before = owner.snapshot();
                await new Promise<void>(resolve => setImmediate(resolve));
                const navigationReads = new Map(catalogReads);
                const navigationCurrentness = currentnessGets;
                for (let navigation = 0; navigation < 20; navigation++) {
                    release();
                    release = owner.observe();
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
                expect(catalogReads).toEqual(navigationReads);
                expect(currentnessGets).toBe(navigationCurrentness);
                expect(owner.snapshot()).toBe(before);
                const applyFeedChange = async (
                  entry: Pick<ApiChangeEntry, 'kind' | 'entityId' | 'hint'>,
                ) => {
                  feedCursor++;
                  feedChanges = [{ ...entry, cursor: feedCursor, changedAt: feedCursor }];
                  await sync.resumeSync('changes-catch-up');
                  // The feed owner has published; drain the observer's asynchronous read/maintenance.
                  await new Promise<void>((resolve) => setImmediate(resolve));
                };
                const unrelatedReads = new Map(catalogReads);
                const unrelatedCurrentness = currentnessGets;
                for (let index = 0; index < 20; index++) {
                  await applyFeedChange({
                    kind: 'kv',
                    entityId: 'self',
                    hint: { keys: ['workspace:tabs:v1'] },
                  });
                }
                expect(
                  catalogReads,
                  'exact workspace-tab feed hints must not read catalogs, Settings or history',
                ).toEqual(unrelatedReads);
                expect(
                  currentnessGets - unrelatedCurrentness,
                  'exact workspace-tab hints need no catalog currentness admission',
                ).toBe(0);
                expect(owner.snapshot()).toBe(before);

                const route =
                  domain === 'providers'
                    ? '/v1/account/entity-rows/provider-connections'
                    : domain === 'acp'
                      ? '/v1/account/entity-rows/acp'
                      : domain === 'metadata'
                        ? '/v1/account/entity-rows/connected-metadata/presentation'
                        : domain === 'remote-hosts'
                          ? '/v1/account/entity-rows/remote-hosts'
                          : `/v1/account/entity-rows/connected-accounts/${domain}`;
                const settleCatalog = async () => {
                  await vi.waitFor(() =>
                    expect(owner.snapshot()).toMatchObject({ status: 'ready', revision }),
                  );
                  if (domain === 'metadata')
                    await vi.waitFor(() =>
                      expect(getConnectedMetadataCatalog(scope).cleanup).toBeUndefined(),
                    );
                  if (domain === 'providers')
                    await vi.waitFor(() =>
                      expect(getProviderCatalogSnapshot(scope)?.catalog).not.toHaveProperty('cleanup'),
                    );
                  if (domain === 'acp')
                    await vi.waitFor(() =>
                      expect(getAcpCatalogSnapshot(scope)?.cleanup?.status).toBe('complete'),
                    );
                  await new Promise<void>((resolve) => setImmediate(resolve));
                };
                const positiveCosts: Array<
                  Readonly<{
                    kind: string;
                    entityId: string;
                    reads: Record<string, number>;
                    currentness: number;
                  }>
                > = [];
                for (const entry of domain === 'remote-hosts'
                  ? []
                  : ([
                      { kind: 'account', entityId: owner.rowIds[0]! },
                      { kind: 'kv', entityId: 'self', hint: { keys: owner.rowIds } },
                      { kind: 'account', entityId: 'self', hint: { settingsVersion: 7 } },
                      { kind: 'kv', entityId: 'self' },
                    ] satisfies Array<Pick<ApiChangeEntry, 'kind' | 'entityId' | 'hint'>>)) {
                  const reads = catalogReads.get(route) ?? 0;
                  const allReads = new Map(catalogReads);
                  const currentness = currentnessGets;
                  revision++;
                  let change = entry;
                  if (entry.kind === 'account' && entry.entityId === 'self') {
                    settingsVersion++;
                    if (domain === 'acp') {
                      // A legacy source edit still wakes its catalog; private-row authority stays intact.
                      settingsRaw = { acpCatalogSettingsV1: { v: 2, backends: [] } };
                      expect(readFreshAcpCatalogSourceV1(settingsRaw).status).toBe('ready');
                    }
                    change = { ...entry, hint: { settingsVersion } };
                  }
                  await applyFeedChange(change);
                  await settleCatalog();
                  expect(
                    (catalogReads.get(route) ?? 0) - reads,
                    `one required ${domain} row read per relevant/unknown feed entry`,
                  ).toBe(1);
                  positiveCosts.push({
                    kind: change.kind,
                    entityId: change.entityId,
                    reads: Object.fromEntries(
                      [...catalogReads]
                        .map(([path, count]) => [path, count - (allReads.get(path) ?? 0)])
                        .filter(([, count]) => count !== 0),
                    ),
                    currentness: currentnessGets - currentness,
                  });
                }
                if (domain !== 'remote-hosts' && domain !== 'acp') {
                  // This client's own write echoes back with the revision its receipt already holds.
                  const echoReads = new Map(catalogReads);
                  const hint = domain === 'providers' ? { providerConnections: true, revision }
                    : domain === 'metadata' ? { connectedMetadata: true, domain: 'presentation', revision }
                      : { connectedAccountCatalog: true, key: domain, revision };
                  await applyFeedChange({ kind: 'account', entityId: owner.rowIds[0]!, hint });
                  await new Promise<void>((resolve) => setImmediate(resolve));
                  expect([...catalogReads].filter(([path]) => path.startsWith('/v1/account/entity-rows/')),
                    'an echo of a held row revision reads no catalog row').toEqual([...echoReads].filter(([path]) => path.startsWith('/v1/account/entity-rows/')));
                  revision++;
                  await applyFeedChange({ kind: 'account', entityId: owner.rowIds[0]!, hint: { ...hint, revision } });
                  await settleCatalog();
                  expect((catalogReads.get(route) ?? 0) - (echoReads.get(route) ?? 0), 'a newer revision still reads its row').toBe(1);
                }
                console.info(
                  'SELFWAKE_COUNTS',
                  JSON.stringify({
                    domain,
                    unrelatedReads: 0,
                    unrelatedCurrentness: 0,
                    positiveCosts,
                  }),
                );
                before = owner.snapshot();
                if (domain === 'acp') {
                    release();
                    expect(getAcpCatalogSnapshot(scope)?.stale).toBe(false);
                    const reads = catalogReads.get('/v1/account/entity-rows/acp') ?? 0;
                    invalidateAccountEncryptionModeCache({ serverId: home.id, reason: 'transport-withdrawal' });
                    // This is the synchronous store reader used by Voice; no
                    // observer is mounted to discover the withdrawal for it.
                    expect(getAcpCatalogSnapshot(scope)?.stale).toBe(true);
                    expect(catalogReads.get('/v1/account/entity-rows/acp') ?? 0).toBe(reads);
                    release = owner.observe();
                    await vi.waitFor(() => expect(getAcpCatalogSnapshot(scope)?.stale).toBe(false));
                    expect(catalogReads.get('/v1/account/entity-rows/acp')).toBe(reads + 1);
                    before = owner.snapshot();
                }
                for (let index = 0; index < 20; index += 1) publishHomeAccountChange(home.id, [`session-${index}`, `machine-${index}`]);
                publishHomeAccountChange(home.id, []);
                expect(owner.snapshot()).toBe(before);
                if (domain === 'metadata') {
                    release();
                    const presentationRoute = '/v1/account/entity-rows/connected-metadata/presentation';
                    const beforeAdmissionWithdrawal = catalogReads.get(presentationRoute) ?? 0;
                    // Currentness has its own socket/withdrawal signal, independent
                    // of the Account-change wake retained by the catalog loader.
                    invalidateAccountEncryptionModeCache({ serverId: home.id });
                    // No observe() or refresh(): synchronous readers must see
                    // the same authority withdrawal before making decisions.
                    expect(getConnectedMetadataCatalog(scope)).toMatchObject({ presentationStale: true, acknowledgementsStale: true });
                    expect(catalogReads.get(presentationRoute) ?? 0).toBe(beforeAdmissionWithdrawal);
                    release = owner.observe();
                    await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ status: 'ready', revision }));
                    expect(catalogReads.get(presentationRoute)).toBe(beforeAdmissionWithdrawal + 1);
                    let releaseProfiles = observeProfileCatalog(scope);
                    try {
                        await vi.waitFor(() => expect(getProfileCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready' }));
                        await new Promise<void>(resolve => setImmediate(resolve));
                        const profiles = getProfileCatalogSnapshot(scope);
                        const profileReads = catalogReads.get(PROFILE_ROWS_ROUTE_V1) ?? 0;
                        const profileNavigationCurrentness = currentnessGets;
                        for (let navigation = 0; navigation < 20; navigation++) {
                            releaseProfiles();
                            releaseProfiles = observeProfileCatalog(scope);
                            await new Promise<void>(resolve => setImmediate(resolve));
                        }
                        expect(catalogReads.get(PROFILE_ROWS_ROUTE_V1) ?? 0).toBe(profileReads);
                        expect(currentnessGets).toBe(profileNavigationCurrentness);
                        expect(getProfileCatalogSnapshot(scope)).toBe(profiles);
                        for (const entityId of owner.rowIds) {
                            revision++;
                            // Drive the content-free advisory producer. The bus must
                            // derive relevance itself before any detailed feed page.
                            publishHomeAccountChange(home.id, [entityId], { source: 'socket', changeKinds: ['account'] });
                            await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ status: 'ready', revision }));
                            // Rows publish before the final currentness proof. That completion,
                            // not one event-loop turn, establishes the quiet-read baseline; no
                            // retained root remains, so the read owes no source cleanup.
                            await vi.waitFor(() => expect(getConnectedMetadataCatalog(scope)).toMatchObject({
                                presentation: { status: 'ready', revision },
                                acknowledgements: { status: 'ready', revision },
                            }));
                            expect(getConnectedMetadataCatalog(scope).cleanup).toBeUndefined();
                            await new Promise<void>(resolve => setImmediate(resolve));
                            expect((catalogReads.get(PROFILE_ROWS_ROUTE_V1) ?? 0) - profileReads).toBe(0);
                            expect(getProfileCatalogSnapshot(scope)).toBe(profiles);
                        }
                    } finally { releaseProfiles(); }
                    await new Promise<void>(resolve => setImmediate(resolve));
                    const settledGets = currentnessGets;
                    for (let index = 0; index < 1_000; index++) publishHomeAccountChange(home.id, [`session-${index}`], {
                        source: 'catch-up-pending', changeKinds: ['session'],
                    });
                    publishHomeAccountChange(home.id, undefined, { source: 'catch-up-pending', changeKinds: ['session'] });
                    publishHomeAccountChange(home.id, undefined, { changeKinds: ['session'] });
                    publishHomeAccountChange(home.id, undefined, { source: 'catch-up-pending', changeKinds: ['savedSecretResource'] });
                    publishHomeAccountChange(home.id, undefined, { source: 'catch-up-pending', changeKinds: ['account'] });
                    publishHomeAccountChange(home.id, ['session-record:visual-record'], { source: 'socket', changeKinds: ['account'],
                        sessionSystemRecords: [{ sessionId: 'session-one', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } }] });
                    await new Promise<void>(resolve => setImmediate(resolve));
                    expect(currentnessGets - settledGets).toBe(0);
                    for (const changeKinds of [['account'], undefined, [], ['future-domain'], ['kv']] as const) {
                        const beforeWake = currentnessGets;
                        publishHomeAccountChange(home.id, undefined, { source: 'socket', changeKinds,
                            ...(changeKinds?.[0] === 'future-domain' ? { accountSettingsAffects: false } : {}) });
                        await vi.waitFor(() => expect(currentnessGets).toBeGreaterThan(beforeWake));
                        await owner.refresh();
                        await new Promise<void>(resolve => setImmediate(resolve));
                        expect(owner.snapshot()).toMatchObject({ status: 'ready', revision });
                    }
                }
                if (domain === 'configurations' || domain === 'purposes') {
                    const path = `/v1/account/entity-rows/connected-accounts/${domain}`;
                    const initialReads = catalogReads.get(path) ?? 0;
                    // Replay 60 seconds of settled machine Usage notifications. Only the
                    // clock and physical transports are substituted; wake routing, Account
                    // admission, catalog reads and snapshot publication are real.
                    vi.useFakeTimers({ toFake: ['Date'] });
                    const startedAt = Date.now();
                    try {
                        for (let elapsed = 2_000; elapsed <= 60_000; elapsed += 2_000) {
                            vi.setSystemTime(startedAt + elapsed);
                            await handleEphemeralSocketUpdate({
                                sourceServerId: home.id,
                                update: { type: 'usage-sources-invalidated', machineId: 'selected-machine', installationId: 'installation' },
                                addActivityUpdate: () => {}, addMachineActivityUpdate: () => {},
                                getSessionEncryption: () => null, getSession: () => undefined, applyMessages: () => {},
                            });
                            await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ status: 'ready', revision }));
                        }
                    } finally { vi.useRealTimers(); }
                    const refreshReads = (catalogReads.get(path) ?? 0) - initialReads;
                    console.info(JSON.stringify({ method: 'GET', path, status: 200, durationMs: 60_000, notifications: 30, initialReads, refreshReads }));
                    expect(refreshReads).toBe(0);
                    expect(owner.snapshot()).toBe(before);
                }
                const releaseSibling = domain === 'configurations' ? observeConnectedAccountCatalog(scope, 'purposes') : () => {};
                try {
                    if (domain === 'configurations') await vi.waitFor(() => expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'ready' }));
                    for (const entityIds of [...owner.rowIds.map(id => [id]), ['self'], undefined]) {
                        revision += 1;
                        const incumbent = owner.snapshot();
                        const siblingReads = catalogReads.get('/v1/account/entity-rows/connected-accounts/purposes') ?? 0;
                        publishHomeAccountChange(home.id, entityIds);
                        if (domain === 'providers' || domain === 'configurations' || domain === 'purposes' || domain === 'metadata') {
                            expect(owner.snapshot()).toBe(incumbent);
                        } else {
                            expect(owner.snapshot()).not.toBe(incumbent);
                        }
                        await owner.refresh();
                        await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ status: 'ready', revision }));
                        expect(owner.snapshot()).not.toBe(incumbent);
                        if (domain === 'configurations' && entityIds?.[0] === owner.rowIds[0]) {
                            await new Promise<void>(resolve => setImmediate(resolve));
                            expect(catalogReads.get('/v1/account/entity-rows/connected-accounts/purposes') ?? 0).toBe(siblingReads);
                        }
                    }
                } finally { releaseSibling(); }
                if (domain === 'acp') {
                    release();
                    expect(getAcpCatalogSnapshot(scope)?.stale).toBe(false);
                    retireActiveServerAccountScopeLifetime();
                    expect(getAcpCatalogSnapshot(scope)?.stale).toBe(true);
                }
            } finally { release(); }
        },
    );
});

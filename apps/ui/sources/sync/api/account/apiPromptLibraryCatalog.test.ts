import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildPromptLibraryPhysicalKeyV1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { applyPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue,
  resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { observePromptLibraryCatalog, refreshPromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { mutatePromptLibraryRoleOverride, readPromptLibraryCatalogProjection } from './apiPromptLibraryCatalog';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  await disconnectActiveServerConnection();
  retireActiveServerAccountScopeLifetime();
  resetRuntimeFetch();
});

describe('Prompt catalog captured Account mutation publication', () => {
  it('keeps prompt authority across unrelated Home changes and refreshes actual prompt or Account changes', async () => {
    const accountId = 'account-prompt-change-scope';
    let revision = 1;
    let catalogReads = 0;
    // Only Home HTTP is replaced; the real loader, Account admission and catalog publication run.
    setRuntimeFetch(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === '/v1/account/entity-rows/prompt-library') {
        catalogReads += 1;
        return Response.json({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
          key, revision, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
        })) });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await disconnectActiveServerConnection();
    const home = await upsertAndActivateServer({ serverUrl: 'https://prompt-change-scope.example.test', name: 'Prompt changes' });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
    await restoreConnectionToActiveServer(credentials);
    const scope = { serverId: home.id, accountId };
    getStorage().setState({ profileScope: scope, settingsScope: scope });
    await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(7));
    const release = observePromptLibraryCatalog(scope);
    try {
      await refreshPromptLibraryCatalog(scope);
      const before = getPromptLibraryCatalogValue(scope, 'role-overrides');
      expect(before).toMatchObject({ status: 'ready', revision: 1, stale: false });
      expect(catalogReads).toBe(1);
      for (let index = 0; index < 20; index += 1) {
        publishHomeAccountChange(home.id, [`session-${index}`, `machine-${index}`]);
      }
      expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toBe(before);
      expect(catalogReads).toBe(1);

      for (const changedIds of [[buildPromptLibraryPhysicalKeyV1('role-overrides')], ['self'], undefined]) {
        revision += 1;
        publishHomeAccountChange(home.id, changedIds);
        expect(getPromptLibraryCatalogValue(scope, 'role-overrides').stale).toBe(true);
        await refreshPromptLibraryCatalog(scope);
        expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toMatchObject({ status: 'ready', revision, stale: false });
        expect(catalogReads).toBe(revision);
      }
    } finally { release(); }
  });

  it('withdraws stale Role authority and publishes the durable receipt despite caller cancellation', async () => {
    const accountId = 'account-prompt-ack';
    const controller = new AbortController();
    let revision = 1;
    // Only Home HTTP is replaced; qualified credentials, Account lifetime, crypto, store and CAS stay real.
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision, content: { t: 'plain',
          v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
            builder: { roleId: 'builder', workspaceWrites: revision === 1 ? 'allow' : 'deny' },
          } } } : emptyPromptLibraryRecordV1(key) } })) });
      if (path === '/v1/account/entity-rows/prompt-library/role-overrides' && init?.method === 'POST') {
        expect(PromptLibraryRowMutationV1Schema.parse(JSON.parse(String(init.body))).expectedRevision).toBe(1);
        revision = 2;
        controller.abort();
        return Response.json({ status: 'updated', revision: 2, cursor: 2 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await disconnectActiveServerConnection();
    const home = await upsertAndActivateServer({ serverUrl: 'https://prompt-ack-home.example.test', name: 'Prompt ack' });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
    await restoreConnectionToActiveServer(credentials);
    const scope = { serverId: home.id, accountId };
    getStorage().setState({ profileScope: scope, settingsScope: scope });
    await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(7));
    const settingsVersion = getStorage().getState().settingsVersion;
    applyPromptLibraryCatalogSnapshot(scope, await readPromptLibraryCatalogProjection(scope), true);
    expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toMatchObject({ status: 'ready', revision: 1 });
    await expect(mutatePromptLibraryRoleOverride(scope, { kind: 'set', override: {
      roleId: 'builder', workspaceWrites: 'deny',
    } }, controller.signal)).resolves.toBeUndefined();
    expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toMatchObject({ status: 'ready', revision: 2,
      value: { overrides: { builder: { workspaceWrites: 'deny' } } } });
    expect(getStorage().getState().settingsVersion).toBe(settingsVersion);
  });
});

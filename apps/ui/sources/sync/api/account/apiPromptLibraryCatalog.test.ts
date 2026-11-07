import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildPromptLibraryPhysicalKeyV1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema,
  StoredPromptLibraryRecordV1Schema, PromptLibraryRowMutationV1Schema, PromptLibraryRowMutationResponseV1Schema,
  PROMPT_LIBRARY_ROWS_ROUTE_V1, openPromptLibraryContentV1, sealPromptLibraryContentV1,
  type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { applyPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue,
  resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const { getStorage } = await import('@/sync/domains/state/storage');
const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { observePromptLibraryCatalog, refreshPromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { mutatePromptLibraryRoleOverride, readPromptLibraryCatalogProjection } = await import('./apiPromptLibraryCatalog');
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  await disconnectActiveServerConnection();
  retireActiveServerAccountScopeLifetime();
  resetRuntimeFetch();
});

describe('Prompt catalog captured Account mutation publication', () => {
  it.each([false, true])('publishes cold folder and rule data only for its captured Account while a wake requires a trailing read (retired: %s)', async retired => {
    const boundary = createPromptLibraryCatalogBoundary({ records: [
      { key: 'folders', value: { v: 1, folders: [{ id: 'work', name: 'Client work' }] } },
      { key: 'skill-rules', value: { v: 1, rules: [{ id: 'everywhere', skillId: 'review',
        target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] } },
    ] });
    const initialRead = createDeferred<void>();
    const trailingRead = createDeferred<void>();
    let reads = 0;
    const accountId = 'cold-prompt-wake';
    const fixture = await createPlainArtifactHomeFixture('https://cold-prompt-wake.test', { accountId, handleRequest: async (path, init) => {
      const response = await boundary.handle(path, init);
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) {
        reads += 1;
        await (reads === 1 ? initialRead : trailingRead).promise;
      }
      if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
      return response;
    } });
    const scope = { serverId: fixture.home.id, accountId };
    const release = observePromptLibraryCatalog(scope);
    const pending = refreshPromptLibraryCatalog(scope);
    let replacement: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> = null;
    try {
      await vi.waitFor(() => expect(reads).toBe(1));
      publishHomeAccountChange(scope.serverId, [buildPromptLibraryPhysicalKeyV1('skill-rules')]);
      if (retired) {
        release();
        replacement = await TokenStorage.setCredentialsForServerUrlWithRollback(fixture.home.serverUrl, { serverId: fixture.home.id }, {
          token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`,
        });
        expect(replacement).not.toBeNull();
      }
      initialRead.resolve();
      if (retired) {
        trailingRead.resolve();
        await pending;
        expect(getPromptLibraryCatalogValue(scope, 'folders').value).toBeNull();
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value).toBeNull();
        return;
      }
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({
        status: 'loading', stale: true, value: { folders: [{ id: 'work', name: 'Client work' }] },
      });
      expect(getPromptLibraryCatalogValue(scope, 'skill-rules')).toMatchObject({
        status: 'loading', stale: true, value: { rules: [{ skillId: 'review', enabled: true }] },
      });
      trailingRead.resolve();
      await pending;
      expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', stale: false });
    } finally {
      initialRead.resolve(); trailingRead.resolve();
      await pending;
      release(); await replacement?.rollback(); await fixture.dispose();
    }
  });
  it('shares a pending row across captures without borrowing cancellation or retaining the settled response', async () => {
    const boundary = createPromptLibraryCatalogBoundary();
    let held = createDeferred<void>();
    let reads = 0;
    const path = `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/folders`;
    const fixture = await createPlainArtifactHomeFixture('https://shared-prompt-row.test', { handleRequest: async (route, init) => {
      const response = await boundary.handle(route, init);
      if (route === path && (init?.method ?? 'GET') === 'GET') {
        reads += 1;
        await held.promise;
      }
      return response;
    } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { readPromptLibraryRowInContext, writePromptLibraryRecordInContext } = await import('./apiPromptLibraryCatalog');
    const caller = new AbortController();
    const firstAccount = await captureLazyActionAccountContext(fixture.home.id, caller.signal);
    const secondAccount = await captureLazyActionAccountContext(fixture.home.id);
    const first = readPromptLibraryRowInContext(firstAccount, 'folders');
    const firstOutcome = first.catch(error => error);
    const second = readPromptLibraryRowInContext(secondAccount, 'folders');
    const pending = [first, second];
    try {
      await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
      caller.abort();
      held.resolve();
      expect(await firstOutcome).toBeInstanceOf(Error);
      expect(await second).toMatchObject({ status: 'present', revision: 1 });
      expect(reads).toBe(1);
      held = createDeferred<void>();
      const beforeWrite = readPromptLibraryRowInContext(secondAccount, 'folders');
      pending.push(beforeWrite);
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(await writePromptLibraryRecordInContext(secondAccount, {
        record: { key: 'folders', value: { v: 1, folders: [{ id: 'new', name: 'New' }] } }, expectedRevision: 1,
      })).toMatchObject({ status: 'updated', revision: 2 });
      const afterWrite = readPromptLibraryRowInContext(secondAccount, 'folders');
      pending.push(afterWrite);
      await vi.waitFor(() => expect(reads).toBe(3));
      held.resolve();
      expect(await beforeWrite).toMatchObject({ status: 'present', revision: 1 });
      expect(await afterWrite).toMatchObject({ status: 'present', revision: 2 });
      expect(await readPromptLibraryRowInContext(secondAccount, 'folders')).toMatchObject({ status: 'present', revision: 2 });
      expect(reads).toBe(4);
    } finally {
      held.resolve();
      await Promise.allSettled(pending);
      firstAccount.dispose(); secondAccount.dispose();
      await fixture.dispose();
    }
  });
  it('keeps finite Action catalog reads out of retained Settings and history maintenance', async () => {
    const accountId = 'account-finite-prompt-catalog';
    const sourceReads: string[] = [];
    let measuring = false;
    setRuntimeFetch(async (url) => {
      const path = new URL(String(url)).pathname;
      if (measuring && path.startsWith('/v2/account/settings')) sourceReads.push(path);
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json({ status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: sealPromptLibraryContentV1({ mode: 'plain', material: null, record: emptyPromptLibraryRecordV1(key) }) })) });
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await disconnectActiveServerConnection();
    const home = await upsertAndActivateServer({ serverUrl: 'https://finite-prompt-catalog.example.test', name: 'Finite prompt catalog' });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
    await restoreConnectionToActiveServer(credentials);
    const scope = { serverId: home.id, accountId };
    getStorage().setState({ profileScope: scope, settingsScope: scope });
    await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(7));
    measuring = true;
    const finite = await readPromptLibraryCatalogProjection(scope);
    expect(finite.catalog).toMatchObject({ status: 'ready', rows: expect.arrayContaining([
      expect.objectContaining({ record: expect.objectContaining({ key: 'skill-rules' }), revision: 1 }),
    ]) });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sourceReads).toEqual([]);
    // The existing observed catalog lifecycle still owns retained-source maintenance.
    const release = observePromptLibraryCatalog(scope);
    try {
      await refreshPromptLibraryCatalog(scope);
      await vi.waitFor(() => expect(sourceReads).toContain('/v2/account/settings'));
    } finally { release(); }
  });
  it('migrates Account and Voice skills through captured Home HTTP and strict row CAS without losing custody or user Off', async () => {
    const accountId = 'account-prompt-skill-migration';
    const coding = PromptLibraryRecordV1Schema.parse(StoredPromptLibraryRecordV1Schema.parse({ key: 'coding', value: {
      v: 1, scope: { kind: 'coding' }, entries: [
        { id: 'legacy-skill', enabled: true, placement: 'skill_instructions', editPolicy: 'user_only', ref: { kind: 'bundle', artifactId: 'skill' } },
        { id: 'disabled', enabled: false, placement: 'system_append', ref: { kind: 'bundle', artifactId: 'disabled-skill' } },
        { id: 'generic', enabled: true, placement: 'system_append', maxChars: 300, ref: { kind: 'bundle', artifactId: 'generic' } },
        { id: 'doc', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'document' } },
      ],
    } }));
    const voice = PromptLibraryRecordV1Schema.parse(StoredPromptLibraryRecordV1Schema.parse({ key: 'voice', value: {
      v: 1, scope: { kind: 'voice' }, entries: [
        { id: 'voice-skill', enabled: true, placement: 'system_append', editPolicy: 'user_only', ref: { kind: 'bundle', artifactId: 'voice-only' } },
        { id: 'voice-generic', enabled: true, placement: 'system_append', ref: { kind: 'bundle', artifactId: 'generic' } },
      ],
    } }));
    const rows = new Map<PromptLibraryCatalogKeyV1, { record: PromptLibraryRecordV1; revision: number }>(
      PromptLibraryCatalogKeyV1Schema.options.map(key => [key, { record: emptyPromptLibraryRecordV1(key), revision: 1 }]));
    rows.set('coding', { record: coding, revision: 1 });
    rows.set('voice', { record: voice, revision: 1 });
    rows.set('skill-rules', { record: PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: { v: 1, rules: [] } }), revision: 1 });
    const writes: ReturnType<typeof PromptLibraryRowMutationV1Schema.parse>[] = [];
    let artifactUnavailable = true;
    let additiveStoredFields = false;
    let miswiredRules = false;
    // Only Home HTTP is replaced; Account custody, Artifact decoding, migration,
    // mutation sealing, strict wire admission and catalog reload remain real.
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path.startsWith('/v1/artifacts/')) {
        if (artifactUnavailable) return Response.json({ error: 'not_found' }, { status: 404 });
        const id = decodeURIComponent(path.slice('/v1/artifacts/'.length));
        const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: id,
          bundleSchemaId: id === 'generic' ? 'bundle.generic_v1' : 'skills.skill_md_v1' });
        const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
          { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${id}\ndescription: Fixture skill\n---\nUse the fixture.`).toString('base64') },
        ] });
        return Response.json({ id, ownerAccountId: accountId, access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
          header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      }
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [...rows].map(([key, row]) => {
        const content = sealPromptLibraryContentV1({ mode: 'plain', material: null, record: row.record });
        if (key !== 'skill-rules' || content.t !== 'plain' || row.record.key !== 'skill-rules')
          return { key, revision: row.revision, content };
        // Preserve actual IR-101a migration/CAS output; only the Home HTTP boundary adds future stored fields.
        return { key, revision: row.revision, content: { ...content, v: miswiredRules ? rows.get('coding')!.record
          : additiveStoredFields ? { ...row.record, futureRecord: true,
            value: { ...row.record.value, futureValue: true, rules: row.record.value.rules.map(rule => ({ ...rule, futureRule: true })) } }
          : row.record } };
      }) });
      if (path.startsWith(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/`) && init?.method === 'POST') {
        const key = PromptLibraryCatalogKeyV1Schema.parse(path.slice(PROMPT_LIBRARY_ROWS_ROUTE_V1.length + 1));
        const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        const current = rows.get(key)!;
        expect(mutation.expectedRevision).toBe(current.revision);
        const opened = openPromptLibraryContentV1({ key, mode: 'plain', material: null, content: mutation.content });
        if (opened.status !== 'opened') throw new Error('Expected the strict real row producer');
        rows.set(key, { record: opened.record, revision: current.revision + 1 });
        writes.push(mutation);
        return Response.json(PromptLibraryRowMutationResponseV1Schema.parse({ status: 'updated', revision: current.revision + 1, cursor: writes.length }));
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    await disconnectActiveServerConnection();
    const home = await upsertAndActivateServer({ serverUrl: 'https://prompt-skill-migration.example.test', name: 'Prompt migration' });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
    await restoreConnectionToActiveServer(credentials);
    const scope = { serverId: home.id, accountId };
    getStorage().setState({ profileScope: scope, settingsScope: scope });
    await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(7));
    const unavailable = await readPromptLibraryCatalogProjection(scope);
    expect(unavailable.catalog).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining([
      expect.objectContaining({ key: 'coding' }), expect.objectContaining({ key: 'voice' }),
    ]) });
    expect(writes).toHaveLength(0);
    expect(rows.get('coding')?.record).toEqual(coding);
    expect(rows.get('voice')?.record).toEqual(voice);
    artifactUnavailable = false;
    const migrated = await readPromptLibraryCatalogProjection(scope);
    expect(migrated.catalog.status).toBe('ready');
    // Classification is a finite content observation, not a whole-library refresh.
    expect(getStorage().getState().artifacts.skill).toBeUndefined();
    expect(getStorage().getState().artifacts.generic).toBeUndefined();
    expect(rows.get('coding')?.record).toEqual(coding);
    expect(rows.get('voice')?.record).toMatchObject({ key: 'voice', value: { entries: [expect.objectContaining({ id: 'voice-generic' })] } });
    const rules = rows.get('skill-rules')!;
    expect(rules.record).toMatchObject({ key: 'skill-rules', value: { rules: [expect.objectContaining({
      id: 'migrated-stack:account:legacy-skill', skillId: 'skill', target: { t: 'allMachines' }, enabled: true,
    })], consumedLegacyEntryIds: ['migrated-stack:account:legacy-skill'] } });
    expect(writes).toHaveLength(2);
    additiveStoredFields = true;
    const additive = await readPromptLibraryCatalogProjection(scope);
    expect(additive.catalog.status).toBe('ready');
    if (additive.catalog.status !== 'ready') throw new Error('Expected tolerant stored catalog');
    expect(additive.catalog.rows.find(row => row.record.key === 'skill-rules')?.record).toEqual(rules.record);
    expect(writes).toHaveLength(2);
    // Deliberately bind the rules address to another real row: identity must still fail closed.
    miswiredRules = true;
    expect((await readPromptLibraryCatalogProjection(scope)).catalog).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining([
      expect.objectContaining({ key: 'skill-rules', reason: 'invalid-stored-content' }),
    ]) });
    miswiredRules = false;
    expect((await readPromptLibraryCatalogProjection(scope)).catalog.status).toBe('ready');
    await readPromptLibraryCatalogProjection(scope);
    expect(writes).toHaveLength(2);
    if (rules.record.key !== 'skill-rules') throw new Error('Expected canonical skill rules');
    rows.set('skill-rules', { revision: rules.revision + 1, record: PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: {
      ...rules.record.value, rules: rules.record.value.rules.map(rule => ({ ...rule, enabled: false, updatedAt: rule.updatedAt + 1 })),
    } }) });
    expect((await readPromptLibraryCatalogProjection(scope)).catalog.status).toBe('ready');
    expect(rows.get('skill-rules')?.record).toMatchObject({ value: { rules: [expect.objectContaining({ skillId: 'skill', enabled: false })] } });
    expect(writes).toHaveLength(2);
    rows.set('skill-rules', { revision: rules.revision + 2, record: { key: 'skill-rules', value: { ...rules.record.value, rules: [] } } });
    for (let pass = 0; pass < 2; pass++) await readPromptLibraryCatalogProjection(scope);
    expect(rows.get('skill-rules')?.record).toMatchObject({ value: { rules: [],
      consumedLegacyEntryIds: ['migrated-stack:account:legacy-skill'] } });
    expect(writes).toHaveLength(2);
  });
  it.each([false, true])('keeps prompt authority across unrelated Home changes and refreshes actual prompt or Account changes (rejected skill-usage: %s)', async rejectedSkillUsage => {
    const accountId = 'account-prompt-change-scope';
    let revision = 1;
    let catalogReads = 0;
    let initializationAttempts = 0;
    let demandedRefreshes = 1;
    // Only Home HTTP is replaced; the real loader, Account admission and catalog publication run.
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === '/v1/account/entity-rows/prompt-library') {
        catalogReads += 1;
        // A duplicate autonomous read must remain observable even if it forms
        // a microtask loop; fail this HTTP response rather than starving timers.
        if (catalogReads > demandedRefreshes * (rejectedSkillUsage ? 2 : 1)) return Response.json({ error: 'unexpected_catalog_reread' }, { status: 503 });
        return Response.json({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.filter(key => !rejectedSkillUsage || key !== 'skill-usage').map(key => ({
          key, revision, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
        })) });
      }
      if (path === `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-usage` && init?.method === 'POST') {
        const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        expect(mutation.expectedRevision).toBe('absent');
        initializationAttempts += 1;
        return Response.json({ statusCode: 400, code: 'FST_ERR_VALIDATION', error: 'Bad Request',
          message: 'params/key Value does not match the canonical Protocol schema' }, { status: 400 });
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
      expect(catalogReads).toBe(rejectedSkillUsage ? 2 : 1);
      expect(initializationAttempts).toBe(rejectedSkillUsage ? 1 : 0);
      for (let index = 0; index < 20; index += 1) {
        publishHomeAccountChange(home.id, [`session-${index}`, `machine-${index}`]);
      }
      expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toBe(before);
      expect(catalogReads).toBe(rejectedSkillUsage ? 2 : 1);

      for (const changedIds of [[buildPromptLibraryPhysicalKeyV1('role-overrides')], ['self'], undefined]) {
        revision += 1;
        demandedRefreshes += 1;
        publishHomeAccountChange(home.id, changedIds);
        expect(getPromptLibraryCatalogValue(scope, 'role-overrides').stale).toBe(true);
        await refreshPromptLibraryCatalog(scope);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toMatchObject({ status: 'ready', revision, stale: false });
        expect(catalogReads).toBe(demandedRefreshes * (rejectedSkillUsage ? 2 : 1));
        expect(initializationAttempts).toBe(rejectedSkillUsage ? demandedRefreshes : 0);
      }
      if (rejectedSkillUsage) {
        // Rejection stays retryable on deliberate demand without any revision
        // change; cleanup completion alone must never start another attempt.
        demandedRefreshes += 1;
        await refreshPromptLibraryCatalog(scope);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(initializationAttempts).toBe(demandedRefreshes);
        expect(catalogReads).toBe(demandedRefreshes * 2);
        expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toMatchObject({ status: 'ready', revision, stale: false });
      }
    } finally { release(); }
  });

  it('withdraws stale Role authority and publishes the durable receipt despite caller cancellation', async () => {
    const accountId = 'account-prompt-ack';
    const controller = new AbortController();
    let revision = 1;
    let readsAfterWrite = 0;
    // Only Home HTTP is replaced; qualified credentials, Account lifetime, crypto, store and CAS stay real.
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === '/v1/account/entity-rows/prompt-library') {
        if (revision > 1) readsAfterWrite += 1;
        return Response.json({ status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision, content: { t: 'plain',
          v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
            builder: { roleId: 'builder', workspaceWrites: revision === 1 ? 'allow' : 'deny' },
          } } } : emptyPromptLibraryRecordV1(key) } })) });
      }
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
    await vi.waitFor(() => expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toMatchObject({ status: 'ready', revision: 2,
      value: { overrides: { builder: { workspaceWrites: 'deny' } } } }));
    expect(getStorage().getState().settingsVersion).toBe(settingsVersion);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readsAfterWrite).toBe(0);
  });
});

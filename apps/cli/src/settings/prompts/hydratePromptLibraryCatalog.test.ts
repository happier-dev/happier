import axios from 'axios';
import { logger } from '@/ui/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1, loadPromptLibraryCatalogV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActivePromptLibraryCatalogRefresh, commitActivePromptLibraryCatalog, clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { prepareActiveAccountRoleOverrides, prepareActivePromptLibraryRecord, readActiveMachineSkillInstallArtifactIds, refreshActivePromptLibraryCatalog } from './hydratePromptLibraryCatalog';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliPromptLibraryStore } from './promptLibraryStore';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import * as persistence from '@/persistence';
import { refreshDemandedActivePromptLibraryCatalog } from './hydratePromptLibraryCatalog';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

function seedAccount(token: string) {
  const credentials = { token: token.split('.').length === 3 ? token
    : `e30.${Buffer.from(JSON.stringify({ sub: token })).toString('base64url')}.signature`, encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  return credentials;
}

function listed(revision: number, includeBuilder = true) {
  return { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision,
    content: { t: 'plain', v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
      ...(includeBuilder ? { builder: { roleId: 'builder', workspaceWrites: revision === 1 ? 'allow' : 'deny' } } : {}),
    } } } : emptyPromptLibraryRecordV1(key, 1) } })) };
}

function readPublishedRole() {
  return readPromptLibraryCatalogRecordV1({ key: 'role-overrides',
    catalog: getActiveAccountSettingsSnapshot()?.promptLibraryCatalog ?? { status: 'loading' } });
}

describe('CLI prompt catalog acknowledged mutation publication', () => {
  it('refreshes demanded prompt rows without reading retained Settings or history', async () => {
    const credentials = seedAccount('prompt-current-demand');
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const reads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: listed(2) };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      return { status: 404, data: {} };
    });
    await refreshDemandedActivePromptLibraryCatalog({ token: credentials.token });
    expect(readPublishedRole()).toMatchObject({ status: 'ready', record: { value: { overrides: {
      builder: { workspaceWrites: 'deny' } } } } });
    expect(reads.filter(path => path !== '/v1/account/entity-rows/prompt-library'
      && path !== '/v1/account/encryption/currentness')).toEqual([]);
  });
  it('retains confirmed database rollback through prompt catalog hydration', async () => {
    const credentials = seedAccount('prompt-read-rollback');
    const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      return { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
    });
    expect(await refreshActivePromptLibraryCatalog({ credentials })).toMatchObject({
      status: 'unavailable', reason: 'database_transaction_conflict_exhausted' });
    expect(logs).toHaveBeenCalledWith('[Session] Prompt preparation failed', expect.objectContaining({
      step: 'prompt-library.read', errorCode: 'database_transaction_conflict_exhausted', errorClass: 'Error',
    }));
  });
  it.each([
    { status: 500, body: { error: 'database_transaction_conflict_exhausted' }, code: 'outcome_unknown' },
    { status: 503, body: { error: 'database_transaction_conflict_exhausted', statusCode: 503 }, code: 'database_transaction_conflict_exhausted' },
    { status: 503, body: { error: 'database_transaction_conflict_exhausted' }, code: 'outcome_unknown' },
  ])('preserves prompt mutation disposition for HTTP $status / $code', async ({ status, body, code }) => {
    const credentials = seedAccount('prompt-rollback');
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, mutation) => {
      expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/prompt-library/skill-rules');
      expect(PromptLibraryRowMutationV1Schema.parse(mutation)).toMatchObject({ expectedRevision: 4 });
      return { status, data: body };
    });
    await expect(createCliPromptLibraryStore({ credentials }).writeRecord({ expectedRevision: 4,
      record: { key: 'skill-rules', value: { v: 1, rules: [] } } })).rejects.toMatchObject({ code });
  });

  it('does not read retained skill install links without an observed raw Settings snapshot', () => {
    const credentials = seedAccount('unobserved-skill-install-source');
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Missing Account fixture');
    // A fresh Account lifetime has no catalog to inherit from the seed helper.
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ ...snapshot, source: 'cache', rawSettings: undefined, promptLibraryCatalog: undefined });
    expect(getActiveAccountSettingsSnapshot()?.rawSettings).toBeUndefined();
    expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog).toBeUndefined();
    expect(readActiveMachineSkillInstallArtifactIds({ token: credentials.token,
      machineInstallDemand: { target: { serverIdentityId: 'a'.repeat(64), machineId: 'machine-a' },
        libraryServerIdentityId: 'a'.repeat(64) } })).toEqual([]);
  });

  it('admits captured invocation Role reads before optional retained-source maintenance', async () => {
    const credentials = seedAccount('captured-role-read');
    const snapshot = getActiveAccountSettingsSnapshot()!;
    let current = true;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
      snapshot: { ...snapshot, promptLibraryCatalog: { status: 'loading' } },
      serverHttpBaseUrl: 'https://captured-role.test', isCurrent: async () => current });
    const source = createDeferred<void>();
    const sourceIssued = createDeferred<void>();
    const rows = createDeferred<void>();
    let rowReads = 0;
    let rowRevision = 1;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') { rowReads++; await rows.promise; return { status: 200, data: listed(rowRevision) }; }
      if (path === '/v2/account/settings') { sourceIssued.resolve(); await source.promise;
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } }; }
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected captured Role boundary: ${path}`);
    });
    let admitted = false;
    const preparation = prepareActiveAccountRoleOverrides({ credentials, operationContext,
      scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() })
      .then(result => { admitted = result.status === 'ready'; return result; });
    const coding = prepareActivePromptLibraryRecord({ credentials, operationContext, key: 'coding',
      scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    try {
      rows.resolve();
      await sourceIssued.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(admitted).toBe(true);
      expect(await preparation).toMatchObject({ status: 'ready', overrides: { builder: { workspaceWrites: 'allow' } } });
      expect(await coding).toMatchObject({ status: 'ready' });
      expect(rowReads).toBe(1);
      expect(await prepareActiveAccountRoleOverrides({ credentials, operationContext,
        scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() })).toMatchObject({ status: 'ready' });
      expect(rowReads).toBe(1);
      rowRevision = 2;
      expect(await prepareActiveAccountRoleOverrides({ credentials, operationContext, refresh: true,
        scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() }))
        .toMatchObject({ status: 'ready', overrides: { builder: { workspaceWrites: 'deny' } } });
      expect(rowReads).toBe(2);
      current = false;
      await expect(prepareActiveAccountRoleOverrides({ credentials, operationContext,
        scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() }))
        .resolves.toEqual({ status: 'unavailable', reason: 'scope-retired' });
    } finally { rows.resolve(); source.resolve(); await Promise.allSettled([preparation, coding]); }
  });
  it('sends current private-resource proofs only for a token-bearing registry row',async()=>{
    const base='https://registry-proof-home.example.invalid';
    const credentials=runWithServerHttpBaseUrl(base,()=>seedAccount('proof-owner'));
    const snapshot=getActiveAccountSettingsSnapshot();if(!snapshot)throw new Error('Missing Account fixture');
    const operationContext=createInvocationSavedSecretOperationContextV1({credentials,snapshot,serverHttpBaseUrl:base,isCurrent:async()=>true});
    const ref='happier:shared-secret:v1:proof-secret';const sent:unknown[]=[];
    vi.spyOn(axios,'get').mockImplementation(async url=>{
      const path=new URL(String(url)).pathname;
      if(path==='/v1/account/encryption/currentness')return {status:200,data:{mode:'plain',version:1,settingsVersion:7,signingKeyFingerprint:null,contentKeyFingerprint:null,updatedAt:1}};
      expect(String(url)).toBe(base+'/v1/account/saved-secrets/resources');
      return {status:200,data:SharedSavedSecretListOutputV1Schema.parse({resources:[{
        ref,source:'shared_resource',relationship:'owner',name:'Proof',kind:'token',revision:7,materialStatus:'ready',capabilities:{use:true,rename:true,rotate:true,manageAccess:true,delete:true}}]})};
    });
    vi.spyOn(axios,'post').mockImplementation(async(url,body)=>{
      expect(String(url)).toBe(base+'/v1/account/entity-rows/prompt-library/registry-sources');
      sent.push(PromptLibraryRowMutationV1Schema.parse(body));return {status:200,data:{status:'updated',revision:2,cursor:2}};
    });
    vi.stubGlobal('fetch',async(url:unknown)=>{expect(String(url)).toBe(base+'/v1/features/authenticated');
      return Response.json(FeaturesResponseSchema.parse({features:{teams:{enabled:true}},capabilities:{}}));});
    const store=createCliPromptLibraryStore({credentials,operationContext});
    await store.writeRecord({expectedRevision:1,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[{id:'proof-source',title:'Proof',format:'git',kinds:['skill'],url:'https://github.com/a/b',enabled:true,addedAt:0,token:{secretRef:ref}}]}}});
    expect(sent[0]).toMatchObject({referencedSavedSecretIds:[ref],savedSecretRevisions:[{resourceId:'proof-secret',expectedRevision:7}]});
    await store.writeRecord({expectedRevision:2,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[]}}});
    expect(sent[1]).not.toHaveProperty('referencedSavedSecretIds');expect(sent[1]).not.toHaveProperty('savedSecretRevisions');
  });
  it.each(['invalidation', 'refresh'] as const)('requires a new Role row observation after %s during source maintenance', async demand => {
    const credentials = seedAccount('prompt-refresh-during-maintenance');
    const incumbent = getActiveAccountSettingsSnapshot()!;
    const bound = { scopeKey: incumbent.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    setActiveAccountSettingsSnapshot({ ...incumbent, promptLibraryCatalog: { status: 'loading' } });
    const source = createDeferred<void>();
    const sourceIssued = createDeferred<void>();
    let rowsUnavailable = false;
    let revision = 1;
    // Only Home HTTP is replaced; the catalog phases and Account publication remain real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') {
        if (rowsUnavailable) throw new Error('Home unavailable');
        return { status: 200, data: listed(revision, revision !== 3) };
      }
      if (path === '/v2/account/settings') { sourceIssued.resolve(); await source.promise;
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } }; }
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected refresh boundary: ${path}`);
    });
    const maintenance = refreshActivePromptLibraryCatalog({ credentials });
    const coalesced = prepareActiveAccountRoleOverrides({ credentials, ...bound, refresh: true });
    let recovery: ReturnType<typeof prepareActiveAccountRoleOverrides> | undefined;
    try {
      await sourceIssued.promise;
      expect(await coalesced).toMatchObject({ status: 'ready', overrides: { builder: { workspaceWrites: 'allow' } } });
      expect(await prepareActiveAccountRoleOverrides({ credentials, ...bound })).toMatchObject({
        status: 'ready', overrides: { builder: { workspaceWrites: 'allow' } } });
      if (demand === 'invalidation') beginActivePromptLibraryCatalogRefresh(bound);
      rowsUnavailable = true;
      recovery = prepareActiveAccountRoleOverrides({ credentials, ...bound, refresh: demand === 'refresh' });
      if (demand === 'invalidation') source.resolve();
      expect(await recovery).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
      expect(readPublishedRole()).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
      rowsUnavailable = false;
      revision = 2;
      expect(await prepareActiveAccountRoleOverrides({ credentials, ...bound, refresh: demand === 'refresh' })).toMatchObject({
        status: 'ready', overrides: { builder: { workspaceWrites: 'deny' } } });
      revision = 3;
      expect(await prepareActiveAccountRoleOverrides({ credentials, ...bound, refresh: true })).toEqual({
        status: 'ready', overrides: {} });
      source.resolve();
      await maintenance;
      expect(readPublishedRole()).toMatchObject({ status: 'ready', revision: 3,
        record: { value: { overrides: {} } } });
      expect(await prepareActiveAccountRoleOverrides({ credentials, ...bound })).toEqual({ status: 'ready', overrides: {} });
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    } finally { source.resolve(); await recovery; await maintenance; }
  });
  it.each([false, true])('makes observed Role overrides available without awaiting source/history maintenance (equal-row refresh=%s)', async equalRowRefresh => {
    const credentials = seedAccount('prompt-admission-maintenance');
    // Retain the Account lifetime, but demand its previously unobserved catalog.
    const incumbent = getActiveAccountSettingsSnapshot()!;
    setActiveAccountSettingsSnapshot({ ...incumbent, settingsVersion: 8, promptLibraryCatalog: { status: 'loading' } });
    const source = createDeferred<void>();
    const sourceIssued = createDeferred<void>();
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 8, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: listed(1) };
      if (path === '/v2/account/settings') { sourceIssued.resolve(); await source.promise;
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 8 } }; }
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected admission boundary: ${path}`);
    });
    if (equalRowRefresh) {
      const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
        readRows: async () => PromptLibraryRowsListResponseV1Schema.parse(listed(1)) });
      commitActivePromptLibraryCatalog({ scopeKey: incumbent.scopeKey!,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog });
    }
    const notification = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(notification);
    const maintenance = equalRowRefresh ? refreshActivePromptLibraryCatalog({ credentials }) : undefined;
    const preparation = prepareActiveAccountRoleOverrides({ credentials, scopeKey: incumbent.scopeKey!,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    try {
      await sourceIssued.promise;
      expect(readPublishedRole()).toMatchObject({ status: 'ready', revision: 1 });
      expect(await preparation).toMatchObject({ status: 'ready', overrides: { builder: { workspaceWrites: 'allow' } } });
      if (equalRowRefresh) expect(notification).not.toHaveBeenCalled();
    } finally { unsubscribe(); source.resolve(); await preparation; await maintenance; await refreshActivePromptLibraryCatalog({ credentials }); }
  });
  it('admits an actually observed empty Settings version zero for a fresh keyless Account', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'fresh-prompt-account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'none', settings: accountSettingsParse({}), settingsVersion: 0,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: listed(4) };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 0 } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected fresh Account boundary: ${path}`);
    });
    await refreshActivePromptLibraryCatalog({ credentials });
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({ source: 'network', settingsVersion: 0, rawSettings: {} });
  });
  it.each([[false, false], [true, false], [false, true]] as const)('publishes observed retained-source cleanup only into its original Account lifetime (retired=%s, remoteCleaned=%s)', async (retired, remoteCleaned) => {
    const credentials = seedAccount(`prompt-cleanup-${retired}-${remoteCleaned}`);
    const raw = { preferredLanguage: 'de', promptFoldersV1: { v: 1, folders: [{ id: 'retained', name: 'Retained' }] } };
    const incumbent = getActiveAccountSettingsSnapshot()!;
    setActiveAccountSettingsSnapshot({ ...incumbent, settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 8 });
    let sourceVersion = remoteCleaned ? 9 : 8;
    let sourceRaw: Readonly<Record<string, unknown>> = remoteCleaned ? { preferredLanguage: 'de' } : raw;
    let replacement: ReturnType<typeof getActiveAccountSettingsSnapshot> = null;
    // Home HTTP is the only boundary replacement; source CAS and Account publication owners remain real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: sourceVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: listed(4) };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: sourceRaw }, version: sourceVersion } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected cleanup boundary: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).pathname).toBe('/v2/account/settings');
      expect(body).toEqual({ expectedVersion: 8, content: { t: 'plain', v: { preferredLanguage: 'de' } } });
      sourceRaw = { preferredLanguage: 'de' }; sourceVersion = 9;
      if (retired) {
        clearActiveAccountSettingsSnapshot();
        seedAccount(credentials.token);
        replacement = getActiveAccountSettingsSnapshot();
      }
      return { status: 200, data: { success: true, version: 9 } };
    });
    await refreshActivePromptLibraryCatalog({ credentials });
    if (retired) expect(getActiveAccountSettingsSnapshot()).toBe(replacement);
    else expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 9, rawSettings: { preferredLanguage: 'de' },
      settings: { preferredLanguage: 'de' } });
  });
  it('keeps a durable receipt true without publishing it into a replacement Account lifetime', async () => {
    const credentials = seedAccount('prompt-ack-retired');
    let replacementCatalog: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>['promptLibraryCatalog'];
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: listed(1) };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      throw new Error(`Unexpected prompt catalog boundary: ${path}`);
    });
    await refreshActivePromptLibraryCatalog({ credentials });
    vi.spyOn(axios, 'post').mockImplementation(async (_input, body) => {
      expect(PromptLibraryRowMutationV1Schema.parse(body).expectedRevision).toBe(1);
      clearActiveAccountSettingsSnapshot();
      seedAccount(credentials.token);
      replacementCatalog = getActiveAccountSettingsSnapshot()?.promptLibraryCatalog;
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
    });
    await expect(createCliPromptLibraryStore({ credentials }).mutateRoleOverride({ kind: 'set',
      override: { roleId: 'builder', workspaceWrites: 'deny' } })).resolves.toBeUndefined();
    expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog).toBe(replacementCatalog);
  });
  it('publishes the acknowledged Role row even when the caller cancels after its durable receipt', async () => {
    const credentials = seedAccount('prompt-ack-cancel');
    const controller = new AbortController();
    let revision = 1;
    // Only Home HTTP is replaced: mode admission, row decoding, semantic mutation and publication remain real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: listed(revision) };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      throw new Error(`Unexpected prompt catalog boundary: ${path}`);
    });
    await refreshActivePromptLibraryCatalog({ credentials });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/prompt-library/role-overrides');
      expect(PromptLibraryRowMutationV1Schema.parse(body).expectedRevision).toBe(1);
      revision = 2;
      controller.abort();
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
    });
    await expect(createCliPromptLibraryStore({ credentials, signal: controller.signal })
      .mutateRoleOverride({ kind: 'set', override: { roleId: 'builder', workspaceWrites: 'deny' } })).resolves.toBeUndefined();
    expect(readPublishedRole()).toMatchObject({ status: 'ready', revision: 2,
      record: { value: { overrides: { builder: { workspaceWrites: 'deny' } } } } });
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
  });

  it('does not acknowledge a pre-write in-flight read as the post-write refresh', async () => {
    const credentials = seedAccount('prompt-ack-inflight');
    const preWrite = createDeferred<{ status: number; data: ReturnType<typeof listed> }>();
    const preWriteIssued = createDeferred<void>();
    const acknowledged = createDeferred<void>();
    let revision = 1;
    let deferNextRows = false;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') {
        if (deferNextRows) { deferNextRows = false; preWriteIssued.resolve(); return preWrite.promise; }
        return { status: 200, data: listed(revision) };
      }
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      throw new Error(`Unexpected prompt catalog boundary: ${path}`);
    });
    await refreshActivePromptLibraryCatalog({ credentials });
    deferNextRows = true;
    const earlierRefresh = refreshActivePromptLibraryCatalog({ credentials });
    await preWriteIssued.promise;
    vi.spyOn(axios, 'post').mockImplementation(async (_input, body) => {
      expect(PromptLibraryRowMutationV1Schema.parse(body).expectedRevision).toBe(1);
      revision = 2;
      acknowledged.resolve();
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
    });
    const mutation = createCliPromptLibraryStore({ credentials })
      .mutateRoleOverride({ kind: 'set', override: { roleId: 'builder', workspaceWrites: 'deny' } });
    await acknowledged.promise;
    expect(readPublishedRole().status).toBe('unavailable');
    preWrite.resolve({ status: 200, data: listed(1) });
    await earlierRefresh;
    await mutation;
    expect(readPublishedRole()).toMatchObject({ status: 'ready', revision: 2,
      record: { value: { overrides: { builder: { workspaceWrites: 'deny' } } } } });
  });
});

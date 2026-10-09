import { describe, expect, it } from 'vitest';
import { cleanupTransferredProfileSourcesV1, transferLegacyProfilesV1, type LegacyProfileTransferInputV1, type ProfileTransferSourceCleanupInputV1 } from './transferLegacyProfilesV1.js';
import type { ProfileCatalogSnapshotV1 } from './profileCatalogV1.js';
import { prepareLegacyProfileRecordsV1 } from './read.js';
import { openProfileRecordContentV1 } from './profileRecordV1.js';
import { openProfileTransferContentV1, type ProfileTransferMutationV1 } from './profileTransferV1.js';
import { parseSavedSecretCatalogReferenceV1 } from '../account/settings/savedSecretCatalogV1.js';

const source = (id: string) => ({ id, name: id, environmentVariables: [{ name: 'TEAM_FLAG', value: '1', isSecret: false }], createdAt: 1, updatedAt: 1 });
const inactive = (): Extract<ProfileCatalogSnapshotV1, { status: 'ready' }> => ({ status: 'ready', authority: 'inactive', control: null,
  controlRevision: 'absent', records: [], tombstones: [], diagnostics: [], referenceGuardRevision: 'absent' });

function harness(raw: Readonly<Record<string, unknown>>, mode: 'plain' | 'e2ee' = 'plain') {
  let catalog = inactive();
  const mutations: ProfileTransferMutationV1[] = [];
  const material = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
  // Persistence/HTTP boundary: execute the real client preparation, codecs and schemas.
  const input: LegacyProfileTransferInputV1 = { source: { raw, version: 12 }, catalog, artifactsById: new Map(), providerContributions: [], homeServerId: 'home', mode, material,
    assertCurrent: () => undefined, randomBytes: length => new Uint8Array(length).fill(3),
    readSavedSecretRevisions: async refs => ({ status: 'ready', resourcesByRef: new Map(refs.flatMap(ref => {
      const parsed = parseSavedSecretCatalogReferenceV1(ref);
      return parsed?.kind === 'shared_resource' ? [[ref, { resourceId: parsed.id, revision: 4 }] as const] : [];
    })) }),
    readArtifactRevisions: async ids => ({ status: 'ready', resourcesByRef: new Map(ids.map(id => [id, { headerVersion: 2, bodyVersion: 7 }])) }),
    mutateTransfer: async mutation => {
      mutations.push(mutation);
      const opened = openProfileTransferContentV1({ mode, material, content: mutation.content });
      if (opened.status !== 'opened') throw new Error('invalid control');
      const revision = mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1;
      const records = mutation.operation === 'prepare' ? mutation.imports.map(row => {
        const decoded = openProfileRecordContentV1({ mode, material, content: row.content, expectedId: row.id });
        if (decoded.status !== 'opened') throw new Error('invalid record');
        return { record: decoded.record, revision: row.expectedRevision === 'absent' ? 0 : row.expectedRevision + 1 };
      }) : [];
      catalog = { ...catalog, records: [...catalog.records, ...records], authority: opened.record.phase === 'active' ? 'active' : 'inactive',
        control: { record: opened.record, revision }, controlRevision: revision };
      return { status: 'updated', revision, cursor: revision };
    }, reloadCatalog: async () => catalog };
  return { input, mutations, read: () => catalog };
}

describe('consumed predecessor Profile transfer', () => {
  it('retains explicit secret unbinding without requesting a null resource', async () => {
    const h = harness({ profiles: [{ ...source('old'), environmentVariables: [
      { name: 'ANTHROPIC_API_KEY', value: '${TOKEN}', isSecret: true },
    ] }], secretBindingsByProfileId: { old: { TOKEN: 'happier:shared-secret:v1:token' } } });
    const record = prepareLegacyProfileRecordsV1({ profiles: [source('old')] }).records[0]!;
    // The admitted daemon preparation response is the transport boundary; its
    // current Profile schema permits an explicit private NONE override.
    expect(await transferLegacyProfilesV1({ ...h.input, legacySourcePreparation: {
      prepare: async () => ({ status: 'ready', settingsVersion: 12, records: [{ ...record, secretBindings: { TOKEN: null } }] }),
      reloadSource: async () => h.input.source,
    } })).toMatchObject({ status: 'active' });
    expect(h.read().records[0]?.record.secretBindings).toEqual({ TOKEN: null });
    const preparation = h.mutations[0];
    if (preparation?.operation !== 'prepare') throw new Error('missing preparation');
    expect(preparation.imports[0]?.referencedSavedSecretIds).toEqual([]);
    expect(preparation.inventory).toEqual([{ kind: 'account_row', id: 'old', revision: 0 }]);
  });
  it.each(['plain', 'e2ee'] as const)('retains all 257 genuine predecessor records and exact resource proof in %s mode', async mode => {
    // Exact 0.2 Profile producer at clean relevant HEAD 37a6541578749067b49d4579be8c752c9591b8c8.
    const raw = { profiles: Array.from({ length: 257 }, (_, index) => source(`old-${index}`)),
      secretBindingsByProfileId: { 'old-256': { TOKEN: 'happier:shared-secret:v1:last' } }, promptStacksV1: { v: 1, surfaces: { profilesById: {
        'old-256': [{ id: 'prompt', ref: { kind: 'doc', artifactId: 'doc' }, enabled: true, placement: 'system_append' }],
      } } } };
    const h = harness(raw, mode);
    const result = await transferLegacyProfilesV1(h.input);
    expect(result.status).toBe('active');
    expect(h.read().records).toHaveLength(257);
    expect(h.mutations.map(mutation => mutation.operation)).toEqual(['prepare', 'activate']);
    const preparation = h.mutations[0];
    expect(preparation?.operation).toBe('prepare');
    if (preparation?.operation !== 'prepare') throw new Error('missing preparation');
    expect(preparation.imports).toHaveLength(257);
    expect(preparation.expectedRevision).toBe('absent');
    expect(preparation.inventory).toContainEqual({ kind: 'account_row', id: 'old-256', revision: 0 });
    expect(preparation.inventory).toContainEqual({ kind: 'saved_secret', id: 'last', revision: 4 });
    expect(preparation.imports.find(row => row.id === 'old-256')?.savedSecretRevisions)
      .toEqual([{ resourceId: 'last', expectedRevision: 4 }]);
    expect(preparation.inventory).toContainEqual({ kind: 'artifact', id: 'doc', revision: { headerVersion: 2, bodyVersion: 7 } });
    expect(h.read().records[256]?.record.secretBindings).toEqual({ TOKEN: 'happier:shared-secret:v1:last' });
    expect(raw.profiles).toHaveLength(257);
  });

  it('preserves a newer divergent row and a tombstone without importing or activating', async () => {
    for (const deleted of [false, true]) {
      const h = harness({ profiles: [source('old')] });
      const retained = prepareLegacyProfileRecordsV1(h.input.source.raw).records[0]!;
      const catalog = { ...inactive(), records: deleted ? [] : [{ record: { ...retained, enabled: false }, revision: 7 }],
        tombstones: deleted ? [{ id: 'old', revision: 7 }] : [] };
      expect(await transferLegacyProfilesV1({ ...h.input, catalog })).toMatchObject({ status: 'pending', reason: 'destination-diverged' });
      expect(h.mutations).toEqual([]);
    }
  });

  it('resumes identical retained rows at their actual revisions without rewriting them', async () => {
    const h = harness({ profiles: [source('old')] });
    const record = prepareLegacyProfileRecordsV1(h.input.source.raw).records[0]!;
    const result = await transferLegacyProfilesV1({ ...h.input, catalog: { ...inactive(), records: [{ record, revision: 8 }] } });
    expect(result.status).toBe('active');
    const mutation = h.mutations[0];
    expect(mutation?.operation).toBe('prepare');
    if (mutation?.operation !== 'prepare') throw new Error('missing preparation');
    expect(mutation.imports).toEqual([]);
    expect(mutation.inventory).toContainEqual({ kind: 'account_row', id: 'old', revision: 8 });
  });

  it('keeps future profiles and unavailable reference inventories inactive', async () => {
    const future = harness({ profiles: [source('valid'), { v: 99, id: 'future' }] });
    expect(await transferLegacyProfilesV1(future.input)).toMatchObject({ status: 'incomplete' });
    expect(future.mutations).toEqual([]);
    const secret = harness({ profiles: [source('old')], secretBindingsByProfileId: { old: { TOKEN: 'locked' } } });
    expect(await transferLegacyProfilesV1({ ...secret.input, readSavedSecretRevisions: async () => ({ status: 'partial' }) }))
      .toMatchObject({ status: 'pending', reason: 'resources-not-ready' });
    expect(secret.mutations).toEqual([]);
  });

  it('accepts authoritative empty activation after an ambiguous committed response without replaying old source', async () => {
    const h = harness({ profiles: [source('obsolete')] });
    const control = { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 12, migratedLogicalRevision: 12, inventory: [] };
    const active = { ...inactive(), authority: 'active' as const, control: { record: control, revision: 4 }, controlRevision: 4 };
    let calls = 0;
    const result = await transferLegacyProfilesV1({ ...h.input, mutateTransfer: async () => { calls++; throw new Error('disconnected after commit'); },
      reloadCatalog: async () => active });
    expect(result).toEqual({ status: 'active', control, revision: 4 });
    expect(calls).toBe(1);
    expect(await transferLegacyProfilesV1({ ...h.input, catalog: active, source: { raw: { profiles: 'corrupt' }, version: 19 } }))
      .toEqual({ status: 'active', control, revision: 4 });
    expect(h.mutations).toEqual([]);
  });

  it('refuses a retired Account after preparation before activation', async () => {
    const h = harness({ profiles: [source('old')] });
    const result = transferLegacyProfilesV1({ ...h.input, assertCurrent: () => { if (h.mutations.length) throw new Error('scope-retired'); } });
    await expect(result).rejects.toThrow('scope-retired');
    expect(h.mutations.map(mutation => mutation.operation)).toEqual(['prepare']);
    expect(h.read().authority).toBe('inactive');
  });

  it('transfers an explicitly empty predecessor source and resumes prepared proof without reimporting', async () => {
    const empty = harness({ profiles: [] });
    expect(await transferLegacyProfilesV1(empty.input)).toMatchObject({ status: 'active', control: { inventory: [] } });
    const h = harness({ profiles: [source('old')] });
    const record = prepareLegacyProfileRecordsV1(h.input.source.raw).records[0]!;
    const control = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 12, migratedLogicalRevision: 3,
      inventory: [{ kind: 'account_row' as const, id: 'old', revision: 8 }] };
    const result = await transferLegacyProfilesV1({ ...h.input, catalog: { ...inactive(), records: [{ record, revision: 8 }],
      control: { record: control, revision: 5 }, controlRevision: 5 } });
    expect(result).toMatchObject({ status: 'active', control: { migratedLogicalRevision: 3 } });
    expect(h.mutations.map(mutation => mutation.operation)).toEqual(['activate']);
    expect(h.mutations[0]?.expectedRevision).toBe(5);
  });

  it('never activates after captured source CAS refusal, missing promoted material, or cancellation', async () => {
    const h = harness({ profiles: [source('old')] });
    let calls = 0;
    expect(await transferLegacyProfilesV1({ ...h.input, mutateTransfer: async () => { calls++; return { status: 'settings-conflict', revision: 13 }; } }))
      .toMatchObject({ status: 'pending', response: { status: 'settings-conflict', revision: 13 } });
    expect(calls).toBe(1);
    const secret = harness({ profiles: [source('old')], secretBindingsByProfileId: { old: { TOKEN: 'unpromoted-personal-secret' } } });
    expect(await transferLegacyProfilesV1(secret.input)).toMatchObject({ status: 'pending', reason: 'resources-not-ready' });
    expect(secret.mutations).toEqual([]);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await transferLegacyProfilesV1({ ...h.input, signal: cancelled.signal })).toMatchObject({ status: 'pending', reason: 'cancelled' });
    expect(h.mutations).toEqual([]);
  });

  it('activates the new prepared proof when a referenced resource changes without a Settings version change', async () => {
    const h = harness({ profiles: [source('old')], promptStacksV1: { v: 1, surfaces: { profilesById: { old: [
      { id: 'stack', ref: { kind: 'doc', artifactId: 'doc' }, enabled: true, placement: 'system_append' },
    ] } } } });
    const record = prepareLegacyProfileRecordsV1(h.input.source.raw).records[0]!;
    const staleControl = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 12, migratedLogicalRevision: 3,
      inventory: [{ kind: 'account_row' as const, id: 'old', revision: 8 },
        { kind: 'artifact' as const, id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 } }] };
    const result = await transferLegacyProfilesV1({ ...h.input, catalog: { ...inactive(), records: [{ record, revision: 8 }],
      control: { record: staleControl, revision: 5 }, controlRevision: 5 } });
    expect(result).toMatchObject({ status: 'active', control: { migratedLogicalRevision: 12,
      inventory: expect.arrayContaining([{ kind: 'artifact', id: 'doc', revision: { headerVersion: 2, bodyVersion: 7 } }]) } });
  });

  it('keeps unclassified historical environment inactive while admitting fresh and canonical V2 data without a Machine registry', async () => {
    const legacy = harness({ profiles: [{ ...source('old'), environmentVariables: [{ name: 'DEEPSEEK_AUTH_TOKEN', value: 'private-literal' }] }] });
    expect(await transferLegacyProfilesV1({ ...legacy.input, providerContributions: null }))
      .toMatchObject({ status: 'pending', reason: 'provider-classification-unavailable' });
    expect(legacy.mutations).toEqual([]);
    const publicProfile = harness({ profiles: [source('public')] });
    expect(await transferLegacyProfilesV1({ ...publicProfile.input, providerContributions: null })).toMatchObject({ status: 'active' });
    const fresh = harness({});
    expect(await transferLegacyProfilesV1({ ...fresh.input, providerContributions: null })).toEqual({ status: 'not-required', reason: 'no-predecessor-source' });
    expect(fresh.mutations).toEqual([]);
    const slim = harness({ profiles: [{ v: 2, id: 'slim', name: 'Slim', createdAt: 1, updatedAt: 1 }] });
    expect(await transferLegacyProfilesV1({ ...slim.input, providerContributions: null })).toMatchObject({ status: 'active' });
  });

  it('preserves the Artifact id and its validated revision instead of admitting a newer unread definition', async () => {
    const h = harness({ profiles: [{ artifactId: 'published' }] });
    const artifact = { artifactId: 'published', revision: { headerVersion: 2, bodyVersion: 7 },
      header: { kind: 'launch-profile.v1', profileId: 'shared', name: 'Shared' }, body: JSON.stringify({ kind: 'launch-profile.v1',
        profile: { v: 2, id: 'shared', name: 'Shared', createdAt: 1, updatedAt: 1 }, secretBindings: {} }) };
    const good = await transferLegacyProfilesV1({ ...h.input, artifactsById: new Map([['published', artifact]]) });
    expect(good.status).toBe('active');
    expect(h.read().records[0]?.record).toMatchObject({ id: 'shared', definition: { kind: 'artifact', artifactId: 'published' } });
    const stale = harness({ profiles: [{ artifactId: 'published' }] });
    expect(await transferLegacyProfilesV1({ ...stale.input, artifactsById: new Map([['published', artifact]]),
      readArtifactRevisions: async () => ({ status: 'ready', resourcesByRef: new Map([['published', { headerVersion: 2, bodyVersion: 8 }]]) }) }))
      .toMatchObject({ status: 'pending', reason: 'resources-not-ready' });
    expect(stale.mutations).toEqual([]);
  });

  it('uses accepted Provider credential descriptors before activating an unflagged inline literal', async () => {
    const h = harness({ profiles: [{ ...source('old'), environmentVariables: [{ name: 'DEPLOY_TOKEN', value: 'private-literal' }] }] });
    const result = await transferLegacyProfilesV1({ ...h.input, providerContributions: [{ legacyProfileMigrations: [{
      sourceProfileId: 'old', descriptorRevision: 1, implicitModelAliasReplacements: [],
      credentialBinding: { legacyEnvVarName: 'DEPLOY_TOKEN', credentialSlotId: 'api_key' },
      migratedEnvironmentVariables: [{ name: 'DEPLOY_TOKEN', value: '${DEPLOY_TOKEN}' }], retainedEnvironmentVariables: [],
    }] }] });
    expect(result).toMatchObject({ status: 'incomplete', diagnostics: expect.arrayContaining([
      { profileId: 'old', reason: 'inline-secret-requires-promotion' },
    ]) });
    expect(h.mutations).toEqual([]);
  });

  it('retains qualified foreign prompt refs without reading a colliding local Artifact id', async () => {
    const h = harness({ profiles: [source('old')], promptStacksV1: { v: 1, surfaces: { profilesById: { old: [
      { id: 'foreign', ref: { kind: 'doc', artifactId: 'collision', serverId: 'elsewhere' }, enabled: true, placement: 'system_append' },
      { id: 'local', ref: { kind: 'doc', artifactId: 'same-home', serverId: 'home' }, enabled: true, placement: 'system_append' },
    ] } } } });
    expect(await transferLegacyProfilesV1(h.input)).toMatchObject({ status: 'active', control: { inventory: [
      { kind: 'account_row', id: 'old', revision: 0 }, { kind: 'artifact', id: 'same-home', revision: { headerVersion: 2, bodyVersion: 7 } },
    ] } });
    expect(h.read().records[0]?.record.promptStack[0]?.ref).toEqual({ kind: 'doc', artifactId: 'collision', serverId: 'elsewhere' });
  });

  it('uses the incumbent source preparation result only at its exact freshly read Settings version', async () => {
    const raw = { profiles: [{ ...source('old'), environmentVariables: [{ name: 'TOKEN', value: 'private-literal', isSecret: true }] }] };
    const promoted = { profiles: [{ ...source('old'), environmentVariables: [{ name: 'TOKEN', value: '${TOKEN}', isSecret: true }] }],
      secretBindingsByProfileId: { old: { TOKEN: 'happier:shared-secret:v1:last' } } };
    const records = [...prepareLegacyProfileRecordsV1(promoted).records];
    const h = harness(raw);
    const input: LegacyProfileTransferInputV1 = { ...h.input, providerContributions: null, legacySourcePreparation: {
      prepare: async request => request.expectedSettingsVersion === 12 ? { status: 'ready', settingsVersion: 13, records }
        : { status: 'partial', settingsVersion: 13, diagnostics: [{ reason: 'inline-secret-requires-promotion', profileId: 'old' }] },
      reloadSource: async () => ({ raw: promoted, version: 13 }),
    } };
    expect(await transferLegacyProfilesV1(input)).toMatchObject({ status: 'active', control: { sourceSettingsVersion: 13, migratedLogicalRevision: 13 } });
    expect(h.mutations[0]?.sourceSettingsVersion).toBe(13);
    expect(JSON.stringify(h.mutations)).not.toContain('private-literal');
    const changed = harness(raw);
    expect(await transferLegacyProfilesV1({ ...changed.input, providerContributions: null, legacySourcePreparation: {
      prepare: async () => ({ status: 'ready', settingsVersion: 13, records }),
      reloadSource: async () => ({ raw: promoted, version: 14 }),
    } })).toMatchObject({ status: 'pending', reason: 'source-version-conflict' });
    expect(changed.mutations).toEqual([]);
  });
});

describe('active Profile source cleanup', () => {
  function cleanupHarness() {
    const control = { record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 12, migratedLogicalRevision: 12,
      inventory: [{ kind: 'account_row' as const, id: 'old', revision: 0 }] }, revision: 4 };
    let raw: Readonly<Record<string, unknown>> = { profiles: [source('old')], secretBindingsByProfileId: { old: {} },
      profileEnabledById: { old: false, anthropic: false }, favoriteProfiles: ['old'], density: 'compact' };
    let sourceVersion = 19;
    let historyNormalized = false;
    const input: ProfileTransferSourceCleanupInputV1 = { control, assertCurrent: () => undefined,
      reloadCatalog: async () => ({ ...inactive(), authority: 'active', control, controlRevision: 4, tombstones: [{ id: 'old', revision: 8 }] }),
      readSource: async () => ({ raw, version: sourceVersion }),
      replaceSource: async request => {
        if (request.expectedVersion !== sourceVersion || request.expectedProfileTransferRevision !== control.revision) {
          return { status: 'conflict', currentSettingsVersion: sourceVersion };
        }
        raw = request.raw;
        sourceVersion++;
        return { status: 'applied', settingsVersion: sourceVersion };
      }, normalizeHistory: async () => { historyNormalized = true; return { status: 'complete' }; } };
    return { input, read: () => ({ raw, sourceVersion, historyNormalized, control }) };
  }

  it('cleans only transferred source at the current Settings CAS and then normalizes history', async () => {
    const h = cleanupHarness();
    expect(await cleanupTransferredProfileSourcesV1(h.input)).toEqual({ status: 'complete' });
    expect(h.read()).toMatchObject({ sourceVersion: 20, historyNormalized: true,
      raw: { profileEnabledById: { anthropic: false }, favoriteProfiles: ['old'], density: 'compact' } });
    expect(h.read().raw).not.toHaveProperty('profiles');
    expect(h.read().raw).not.toHaveProperty('secretBindingsByProfileId');
    expect(h.read().control.record.phase).toBe('active');
  });

  it('never cleans an unconfirmed authority and never rolls active control back after cleanup failures', async () => {
    const inactiveCleanup = cleanupHarness();
    expect(await cleanupTransferredProfileSourcesV1({ ...inactiveCleanup.input, reloadCatalog: async () => inactive() }))
      .toMatchObject({ status: 'cleanup-pending', reason: 'authority-not-confirmed' });
    expect(inactiveCleanup.read()).toMatchObject({ sourceVersion: 19, historyNormalized: false });
    const conflict = cleanupHarness();
    expect(await cleanupTransferredProfileSourcesV1({ ...conflict.input, replaceSource: async () => ({
      status: 'conflict', currentSettingsVersion: 20,
    }) })).toMatchObject({ status: 'cleanup-pending', reason: 'source-conflict' });
    expect(conflict.read()).toMatchObject({ sourceVersion: 19, historyNormalized: false, control: { record: { phase: 'active' } } });
    const history = cleanupHarness();
    expect(await cleanupTransferredProfileSourcesV1({ ...history.input, normalizeHistory: async () => ({ status: 'cleanup-pending', versions: [2] }) }))
      .toEqual({ status: 'cleanup-pending', reason: 'history-incomplete', versions: [2] });
    expect(history.read()).toMatchObject({ sourceVersion: 20, control: { record: { phase: 'active' } } });
    const retired = cleanupHarness();
    await expect(cleanupTransferredProfileSourcesV1({ ...retired.input, assertCurrent: () => {
      if (retired.read().sourceVersion === 20) throw new Error('scope-retired');
    } })).rejects.toThrow('scope-retired');
    expect(retired.read()).toMatchObject({ sourceVersion: 20, historyNormalized: false, control: { record: { phase: 'active' } } });
  });
});

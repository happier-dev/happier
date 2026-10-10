import { describe, expect, it } from 'vitest';

import { readProfilesFromAccountSettings } from './readProfilesFromAccountSettings';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';

const activeAuthority = { source: 'destination' as const, authority: 'active' as const, controlRevision: 1,
  control: { revision: 1, record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 1,
    migratedLogicalRevision: 1, inventory: [] } } };

describe('readProfilesFromAccountSettings', () => {
  it('uses row enablement for builtin membership and Settings only for its no-entity neighbor', () => {
    const builtin = getBuiltInBackendProfile('gemini-api-key');
    if (!builtin) throw new Error('Actual readonly builtin preset is unavailable');
    const records = [{ revision: 1, record: { v: 1 as const, id: builtin.id, enabled: true,
      promptStack: [], secretBindings: {}, definition: { kind: 'legacy' as const, profile: builtin } } },
    { revision: 1, record: {
      v: 1 as const, id: 'custom', enabled: true, promptStack: [], secretBindings: {},
      definition: { kind: 'inline' as const, profile: { v: 2 as const, id: 'custom', name: 'Custom',
        createdAt: 1, updatedAt: 1, extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} } },
    } }];
    const result = readProfilesFromAccountSettings({ profileEnabledById: { [builtin.id]: false, custom: false, 'azure-openai': false } },
      undefined, undefined, { ...activeAuthority, status: 'ready', records, referenceGuardRevision: 1, diagnostics: [] });
    expect(result.enabledByProfileId).toMatchObject({ [builtin.id]: true, custom: true, 'azure-openai': false });
    expect(result.profiles.find((profile) => profile.id === builtin.id)?.enabled).toBe(true);
    expect(result.profiles.some(profile => profile.id === 'azure-openai')).toBe(false);
  });
  it('uses every destination row and its bindings instead of retained Settings bytes', () => {
    const records = Array.from({ length: 257 }, (_, index) => ({
      revision: index + 1,
      record: { v: 1 as const, id: `row-${index}`, enabled: index !== 0, promptStack: [],
        definition: { kind: 'inline' as const, profile: { v: 2 as const, id: `row-${index}`, name: `Row ${index}`,
          extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
          compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 } },
        secretBindings: index === 256 ? { TOKEN: 'happier:shared-secret:v1:last' } : {},
      },
    }));
    const catalog = { ...activeAuthority, status: 'ready' as const, records, referenceGuardRevision: 257, diagnostics: [] } satisfies ProfileCatalogSnapshotV1;
    const projected = readProfilesFromAccountSettings({ profiles: [{ v: 99, id: 'stale' }],
      secretBindingsByProfileId: { 'row-256': { TOKEN: 'stale-secret' } }, profileEnabledById: { 'row-0': true } },
    undefined, { lastUsedProfile: null }, catalog);
    expect(projected.profiles).toHaveLength(257);
    expect(projected.visibleProfiles.find((profile) => profile.id === 'row-256')).toMatchObject({ id: 'row-256' });
    expect(projected.secretBindingsByProfileId['row-256']).toEqual({ TOKEN: 'happier:shared-secret:v1:last' });
    expect(projected.enabledByProfileId['row-0']).toBe(false);
    expect(projected.opaqueProfiles).toEqual([]);
    const reloaded = readProfilesFromAccountSettings({}, undefined, { lastUsedProfile: null }, {
      ...catalog, records: records.map((entry) => entry.record.id === 'row-0'
        ? { ...entry, revision: 258, record: { ...entry.record, enabled: true } } : entry), referenceGuardRevision: 258,
    });
    expect(reloaded.enabledByProfileId['row-0']).toBe(true);
  });

  it('uses genuine predecessor Settings only when the opened transfer authority is inactive', () => {
    const profile = { v: 2, id: 'predecessor', name: 'Predecessor', createdAt: 1, updatedAt: 1 };
    const snapshot = readProfilesFromAccountSettings({ profiles: [profile] }, undefined, undefined, {
      status: 'ready', source: 'legacy', authority: 'inactive', control: null, controlRevision: 'absent',
      records: [], diagnostics: [], referenceGuardRevision: 'absent',
    });
    expect(snapshot.profiles.map((entry) => entry.id)).toEqual(['predecessor']);
    expect(readProfilesFromAccountSettings({ profiles: [profile] }, undefined, undefined, {
      ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent',
    }).profiles).toEqual([]);
  });

  it('preserves custom predecessor enablement until its actual destination transfer', () => {
    const result = readProfilesFromAccountSettings({ profiles: [{ v: 2, id: 'retained', name: 'Retained', createdAt: 1, updatedAt: 1 }],
      profileEnabledById: { retained: false } }, undefined, undefined, { status: 'ready', source: 'legacy', authority: 'inactive',
      control: null, controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 'absent' });
    expect(result.enabledByProfileId.retained).toBe(false);
  });

  it('reads native destination rows without a transfer marker and refuses an unadmitted census', () => {
    const profile = { v: 2 as const, id: 'native', name: 'Native', createdAt: 1, updatedAt: 1,
      extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} };
    const catalog = { status: 'ready' as const, source: 'destination' as const, authority: 'inactive' as const,
      control: null, controlRevision: 'absent' as const, diagnostics: [], referenceGuardRevision: 1,
      records: [{ revision: 1, record: { v: 1 as const, id: profile.id, enabled: true, promptStack: [], secretBindings: {},
        definition: { kind: 'inline' as const, profile } } }] };
    expect(readProfilesFromAccountSettings({}, undefined, undefined, catalog).profiles).toMatchObject([{ id: 'native', profileRecordRevision: 1 }]);
    expect(() => readProfilesFromAccountSettings({}, undefined, undefined, { ...catalog, source: undefined }))
      .toThrow(expect.objectContaining({ code: 'profile_catalog_unavailable' }));
  });

  it('refuses incomplete or unavailable destination authority instead of returning legacy or empty profiles', () => {
    for (const catalog of [{ status: 'loading' }, { status: 'unavailable', reason: 'unreachable' },
      { ...activeAuthority, status: 'partial', records: [], diagnostics: [], referenceGuardRevision: 1 }] satisfies ProfileCatalogSnapshotV1[]) {
      expect(() => readProfilesFromAccountSettings({ profiles: [] }, undefined, { lastUsedProfile: null }, catalog))
        .toThrow(expect.objectContaining({ code: 'profile_catalog_unavailable' }));
    }
  });
  it('uses current authoring memory for visibility instead of a retired settings value', () => {
    expect(readProfilesFromAccountSettings({ lastUsedProfile: 'gemini-api-key' }, undefined, { lastUsedProfile: null }).visibleProfiles).toEqual([]);
    expect(readProfilesFromAccountSettings({}, undefined, { lastUsedProfile: 'gemini-api-key' }).visibleProfiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gemini-api-key' })]),
    );
  });
  it('keeps published profiles executable and their Saved Secret references available after the Settings move', () => {
    const artifact = { artifactId: 'published', header: { kind: 'launch-profile.v1', profileId: 'shared', name: 'Shared' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: 'shared', name: 'Shared', createdAt: 1, updatedAt: 1 },
        secretBindings: { TOKEN: 'happier:shared-secret:v1:deploy' } }) };
    const snapshot = readProfilesFromAccountSettings({ profiles: [{ artifactId: 'published' }] }, new Map([['published', artifact]]));
    expect(snapshot.visibleProfiles).toMatchObject([{ id: 'shared', artifactId: 'published' }]);
    expect(snapshot.secretBindingsByProfileId).toEqual({ shared: { TOKEN: 'happier:shared-secret:v1:deploy' } });
    expect(snapshot.opaqueProfiles).toEqual([]);
  });
  it('does not advertise legacy provider-like built-ins on a fresh account', () => {
    expect(readProfilesFromAccountSettings({}).visibleProfiles).toEqual([]);
  });

  it('returns usable legacy/slim profiles while preserving opaque rows and bindings', () => {
    const slim = {
      v: 2, id: 'slim', name: 'Slim', extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: '1' }],
      defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: { 'agent:claude': true },
      createdAt: 1, updatedAt: 1,
    };
    const opaque = { v: 99, id: 'future', keep: true };
    const result = readProfilesFromAccountSettings({
      profiles: [slim, opaque],
      secretBindingsByProfileId: { future: { TOKEN: 'secret-id' } },
    });
    // The catalog rewrites a legacy `agent:<id>` compatibility key to its
    // canonical V2 spelling on parse, so the projected profile is not
    // byte-identical to the stored row.
    expect(result.profiles).toEqual([{
      ...slim,
      compatibilityByTargetKey: { 'agent:happier.agent.claude/claude': true },
    }]);
    expect(result.opaqueProfiles).toEqual([opaque]);
    expect(result.secretBindingsByProfileId).toEqual({ future: { TOKEN: 'secret-id' } });
    expect(result.diagnostics).toHaveLength(1);
  });

  it('never canonicalizes malformed SavedSecret ids while projecting legacy bindings', () => {
    const inherited = Object.create({ TOKEN: 'inherited-secret' });
    const result = readProfilesFromAccountSettings({
      secretBindingsByProfileId: {
        padded: { TOKEN: ' real-secret ' },
        control: { TOKEN: 'bad\u0000secret' },
        oversized: { TOKEN: 'x'.repeat(257) },
        inherited,
        valid: { TOKEN: 'real-secret' },
      },
    });
    expect(result.secretBindingsByProfileId).toEqual({ valid: { TOKEN: 'real-secret' } });
  });

  it('projects the deployed Gemini no-model-pin baseline only when historical account evidence exists', () => {
    const result = readProfilesFromAccountSettings({
      lastUsedProfile: 'gemini-api-key',
      secretBindingsByProfileId: { 'gemini-api-key': { GEMINI_API_KEY: 'secret-id' } },
    });
    const profile = result.profiles.find((entry) => entry.id === 'gemini-api-key');
    expect(profile && !('v' in profile)).toBe(true);
    expect(profile && !('v' in profile) ? profile.environmentVariables : [])
      .not.toContainEqual(expect.objectContaining({ name: 'GEMINI_MODEL' }));

    expect(readProfilesFromAccountSettings({}).profiles).toEqual([]);
  });

  it('does not let a persisted historical Gemini row restore the obsolete model pin', () => {
    const result = readProfilesFromAccountSettings({
      profiles: [{
        id: 'gemini-api-key',
        name: 'Gemini (API key)',
        environmentVariables: [
          { name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' },
          { name: 'TEAM_FLAG', value: '1' },
        ],
        createdAt: 1,
        updatedAt: 1,
      }],
      lastUsedProfile: 'gemini-api-key',
    });

    const visible = result.visibleProfiles.find((profile) => profile.id === 'gemini-api-key');
    expect(visible && !('v' in visible) ? visible.environmentVariables : [])
      .toEqual([{ name: 'TEAM_FLAG', value: '1' }]);
  });

  it('projects one migration-aware post-demotion catalog for list, resolver, and actions', () => {
    const providerSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
      migration: { v: 1, completedSources: [
        { sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_deepseek' },
        { sourceProfileId: 'codex', kind: 'default_environment' },
      ], pendingCustomProfileIds: [], migratedAt: 2 },
    });
    const result = readProfilesFromAccountSettings({
      lastUsedProfile: 'azure-openai',
      profiles: [{
        v: 2, id: 'focused', name: 'Focused', extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
        createdAt: 1, updatedAt: 1,
      }],
    }, undefined, { lastUsedProfile: 'azure-openai' }, undefined, providerSettings);

    expect(result.visibleProfiles.map((profile) => profile.id)).not.toEqual(expect.arrayContaining([
      'anthropic', 'codex', 'gemini', 'deepseek', 'gemini-api-key', 'gemini-vertex',
    ]));
    expect(result.visibleProfiles.map((profile) => profile.id)).toEqual(expect.arrayContaining(['azure-openai', 'focused']));
    expect(result.terminalMigratedProfileIds?.has('deepseek')).toBe(true);
  });
});

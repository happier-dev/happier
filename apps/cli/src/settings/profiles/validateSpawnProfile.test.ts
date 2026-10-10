import { describe, expect, it } from 'vitest';

import { resolveCanonicalSpawnProfile, validateSpawnProfileEnvironment } from './validateSpawnProfile';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { getHistoricalBuiltInAiLaunchProfileV1 } from '@happier-dev/protocol/profiles/historicalCompatibilityV1';

const slim = {
  v: 2 as const,
  id: 'focused',
  name: 'Focused',
  extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: '1' }],
  defaultPermissionModeByTargetKey: {},
  defaultPersistenceModeByTargetKey: {},
  compatibilityByTargetKey: {},
  createdAt: 1,
  updatedAt: 1,
};
const activeAuthority = { source: 'destination' as const, authority: 'active' as const, controlRevision: 1,
  control: { revision: 1, record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 1,
    migratedLogicalRevision: 1, inventory: [] } } };

describe('validateSpawnProfileEnvironment', () => {
  it('uses admitted builtin row enablement instead of a stale ordinary Account preference', () => {
    const profile = getBuiltInBackendProfile('gemini-api-key');
    if (!profile) throw new Error('Missing canonical builtin fixture');
    const profileCatalog = { ...activeAuthority, status: 'ready' as const, records: [{ revision: 1, record: {
      v: 1 as const, id: profile.id, enabled: true, promptStack: [], secretBindings: {},
      definition: { kind: 'legacy' as const, profile },
    } }], diagnostics: [], referenceGuardRevision: 1 };
    expect(resolveCanonicalSpawnProfile({ rawSettings: { profileEnabledById: { [profile.id]: false } },
      profileId: profile.id, profileCatalog })).toEqual({ ok: true, kind: 'legacy' });
    expect(resolveCanonicalSpawnProfile({ rawSettings: { profileEnabledById: { [profile.id]: true } },
      profileId: profile.id, profileCatalog: { ...profileCatalog, records: profileCatalog.records.map(row => ({
        ...row, record: { ...row.record, enabled: false },
      })) } })).toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
  });
  it('binds foreground admission to the captured private row revision, not the Settings revision', () => {
    const input = { rawSettings: {}, profileId: slim.id, expectedProfileRecordRevision: 4,
      profileCatalog: { ...activeAuthority, status: 'ready' as const, records: [{ revision: 4, record: { v: 1 as const, id: slim.id,
        definition: { kind: 'inline' as const, profile: slim }, enabled: true, promptStack: [], secretBindings: {} } }],
      diagnostics: [], referenceGuardRevision: 4 } };
    expect(resolveCanonicalSpawnProfile(input)).toMatchObject({ ok: true, kind: 'slim' });
    expect(resolveCanonicalSpawnProfile({ ...input, expectedProfileRecordRevision: 3 }))
      .toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
    expect(resolveCanonicalSpawnProfile({ ...input, expectedProfileRecordRevision: undefined }))
      .toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
  });
  it('admits only the ready destination definition and refuses disabled or incomplete rows', () => {
    const row = { revision: 4, record: { v: 1 as const, id: slim.id,
      definition: { kind: 'inline' as const, profile: slim }, enabled: true, promptStack: [], secretBindings: {} } };
    const catalog = { ...activeAuthority, status: 'ready' as const, records: [row], diagnostics: [], referenceGuardRevision: 4 };
    const input = { rawSettings: { profiles: [{ ...slim, extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'stale' }] }] },
      profileId: slim.id, profileCatalog: catalog, providedEnvironmentVariables: { TEAM_FLAG: '1' }, reservedEnvironmentVariableNames: new Set<string>() };
    expect(validateSpawnProfileEnvironment(input)).toEqual({ ok: true, kind: 'slim' });
    expect(resolveCanonicalSpawnProfile({ ...input, profileCatalog: { ...catalog,
      records: [{ ...row, record: { ...row.record, enabled: false } }] } })).toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
    expect(resolveCanonicalSpawnProfile({ ...input, profileCatalog: { ...catalog, status: 'partial' } })).toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
    expect(resolveCanonicalSpawnProfile({ ...input, profileCatalog: { status: 'unavailable', reason: 'unreachable' } })).toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
  });
  it('resolves published and grant-visible profiles without pretending a reference is an inline row', () => {
    const profile = { ...slim, extraEnvironmentVariables: [] };
    const resource = { artifactId: 'document', header: { kind: 'launch-profile.v1', profileId: profile.id, name: profile.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'view' as const };
    const artifactsById = new Map([[resource.artifactId, resource]]);
    expect(resolveCanonicalSpawnProfile({ rawSettings: { profiles: [{ artifactId: 'document' }] }, profileId: profile.id, artifactsById }))
      .toMatchObject({ ok: true, kind: 'slim', profile: { id: profile.id, artifactId: 'document', viewOnly: true } });
    expect(resolveCanonicalSpawnProfile({ rawSettings: {}, profileId: profile.id, artifactsById }))
      .toMatchObject({ ok: true, kind: 'slim' });
    expect(resolveCanonicalSpawnProfile({ rawSettings: {}, profileId: profile.id, artifactsById, expectedProfileRecordRevision: undefined }))
      .toMatchObject({ ok: true, kind: 'slim' });
    expect(resolveCanonicalSpawnProfile({ rawSettings: {}, profileId: profile.id, artifactsById, expectedProfileRecordRevision: 1 }))
      .toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
    expect(resolveCanonicalSpawnProfile({ rawSettings: { profiles: [{ artifactId: 'document' }, profile] }, profileId: profile.id, artifactsById }))
      .toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
  });

  it('rejects dynamic agent-owned keys in canonical V2 profiles and mismatched caller overlays', () => {
    expect(validateSpawnProfileEnvironment({
      rawSettings: { profiles: [{ ...slim, extraEnvironmentVariables: [{ name: 'THIRD_PARTY_AUTH', value: 'secret' }] }] },
      profileId: 'focused',
      providedEnvironmentVariables: { THIRD_PARTY_AUTH: 'secret' },
      reservedEnvironmentVariableNames: new Set(['THIRD_PARTY_AUTH']),
    })).toMatchObject({ ok: false, reason: 'reserved_environment' });

    expect(validateSpawnProfileEnvironment({
      rawSettings: { profiles: [slim] },
      profileId: 'focused',
      providedEnvironmentVariables: { TEAM_FLAG: 'caller-substituted' },
      reservedEnvironmentVariableNames: new Set(),
    })).toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
  });

  it('accepts exact V2 overlays and preserves retained V1 compatibility', () => {
    expect(validateSpawnProfileEnvironment({
      rawSettings: { profiles: [slim] },
      profileId: 'focused',
      providedEnvironmentVariables: { TEAM_FLAG: '1', SESSION_ONLY_FLAG: 'allowed' },
      reservedEnvironmentVariableNames: new Set(['THIRD_PARTY_AUTH']),
    })).toEqual({ ok: true, kind: 'slim' });

    expect(validateSpawnProfileEnvironment({
      rawSettings: { profiles: [{
        id: 'azure-openai', name: 'Azure OpenAI',
        environmentVariables: [{ name: 'OPENAI_API_KEY', value: '${AZURE_OPENAI_API_KEY}' }],
        createdAt: 1, updatedAt: 1,
      }] },
      profileId: 'azure-openai',
      providedEnvironmentVariables: { OPENAI_API_KEY: 'legacy-compatible' },
      reservedEnvironmentVariableNames: new Set(['OPENAI_API_KEY']),
    })).toEqual({ ok: true, kind: 'legacy' });
  });

  it('refuses a bare missing historical Profile without erasing actual retained predecessor definitions', () => {
    expect(validateSpawnProfileEnvironment({
      rawSettings: null,
      profileId: 'deepseek',
      providedEnvironmentVariables: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      reservedEnvironmentVariableNames: new Set(['ANTHROPIC_BASE_URL']),
    })).toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });

    expect(validateSpawnProfileEnvironment({
      rawSettings: {},
      profileId: 'deepseek',
      providedEnvironmentVariables: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      reservedEnvironmentVariableNames: new Set(['ANTHROPIC_BASE_URL']),
    })).toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });

    const retained = getHistoricalBuiltInAiLaunchProfileV1('deepseek');
    if (!retained) throw new Error('Actual historical predecessor definition is unavailable');
    expect(validateSpawnProfileEnvironment({
      rawSettings: { profiles: [retained] },
      profileId: 'deepseek',
      providedEnvironmentVariables: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      reservedEnvironmentVariableNames: new Set(['ANTHROPIC_BASE_URL']),
    })).toEqual({ ok: true, kind: 'legacy' });
    expect(resolveCanonicalSpawnProfile({ rawSettings: { profiles: [retained] }, profileId: 'deepseek',
      profileCatalog: { status: 'ready', source: 'legacy', authority: 'inactive', control: null,
        controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 'absent' } }))
      .toEqual({ ok: true, kind: 'legacy' });
    expect(resolveCanonicalSpawnProfile({ rawSettings: { profiles: [retained] }, profileId: 'deepseek',
      profileCatalog: { ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 1 } }))
      .toMatchObject({ ok: false, reason: 'profile_overlay_mismatch' });
  });
});

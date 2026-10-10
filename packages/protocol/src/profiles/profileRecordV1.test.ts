import { describe, expect, it } from 'vitest';
import { ProfileRecordV1Schema, ProfileRowMutationV1Schema, ProfileProviderConversionMutationV1Schema, StoredProfileRecordV1Schema, openProfileRecordContentV1, sealProfileRecordContentV1, buildProfilePhysicalKey, parseProfilePhysicalKey, hasChangedReadonlyProfileDefinitionV1, type ProfileRecordV1 } from './profileRecordV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '../providers/connections/connectionRowsV1.js';
import { getHistoricalBuiltInAiLaunchProfileV1 } from './historicalCompatibilityV1.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema } from '../launchProfiles/launchProfileArtifactV1.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedBlobKind } from '../crypto/accountScopedCipher.js';
import { AccountSettingsV2UpdateRequestSchema } from '../account/settings/accountSettingsApiV2.js';
import { getBuiltInBackendProfile } from './builtInBackendProfiles.js';
import { prepareLegacyProfileRecordsV1 } from './read.js';
import { ProfileTransferControlV1Schema } from './profileTransferV1.js';

const record = {
  v: 1, id: 'profile-a', enabled: true, promptStack: [], secretBindings: {},
  definition: { kind: 'inline', profile: {
    v: 2, id: 'profile-a', name: 'Example', extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
  } },
};

describe('private Profile record', () => {
  it('updates opens and reseals inherited inline Profile bytes without admitting them as new authoring', () => {
    const id = `  legacy/branch\\資料/😀-${'x'.repeat(300)}  `;
    const inherited = { ...record, id, definition: { kind: 'inline', profile: {
      ...record.definition.profile, id, name: '  Retained inherited name  ',
      extraEnvironmentVariables: Array.from({ length: 257 }, (_, index) => ({ name: `PUBLIC_SETTING_${index}`, value: 'public' })),
      envVarRequirements: Array.from({ length: 257 }, (_, index) => ({ name: `PUBLIC_SETTING_${index}`, kind: 'config', required: true })),
    } } };
    expect(openProfileRecordContentV1({ mode: 'plain', material: null, expectedId: id, content: { t: 'plain', v: inherited } }))
      .toEqual({ status: 'opened', record: inherited });
    const admitted = ProfileRecordV1Schema.parse(inherited);
    expect(ProfileRowMutationV1Schema.safeParse({ id, operation: 'update', expectedRevision: 1,
      content: { t: 'plain', v: admitted } }).success).toBe(true);
    expect(ProfileRowMutationV1Schema.safeParse({ id, operation: 'create', expectedRevision: 'absent',
      content: { t: 'plain', v: admitted } }).success).toBe(false);
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    for (const mode of ['plain', 'e2ee'] as const) {
      const modeMaterial = mode === 'plain' ? null : material;
      const content = sealProfileRecordContentV1({ mode, material: modeMaterial, record: admitted,
        randomBytes: length => new Uint8Array(length).fill(3) });
      expect(openProfileRecordContentV1({ mode, material: modeMaterial, expectedId: id, content }))
        .toEqual({ status: 'opened', record: inherited });
    }
  });
  it('prepares and roundtrips the exact long untrimmed predecessor Profile identity through private rows and transfer census', () => {
    const id = `  legacy/branch\\資料/😀-${'x'.repeat(300)}  `;
    const legacy = { ...getBuiltInBackendProfile('azure-openai'), id, isBuiltIn: false, name: 'Retained legacy identity',
      environmentVariables: [], envVarRequirements: [] };
    const prepared = prepareLegacyProfileRecordsV1({ profiles: [legacy] });
    expect(prepared.status).toBe('complete');
    expect(prepared.records.map(entry => entry.id)).toEqual([id]);
    const physicalKey = buildProfilePhysicalKey(id);
    expect(parseProfilePhysicalKey(physicalKey)).toBe(id);
    const saved = prepared.records[0];
    expect(openProfileRecordContentV1({ mode: 'plain', material: null, expectedId: id, content: { t: 'plain', v: saved } }))
      .toEqual({ status: 'opened', record: saved });
    expect(ProfileTransferControlV1Schema.safeParse({ v: 1, phase: 'prepared', sourceSettingsVersion: 2, migratedLogicalRevision: 2,
      inventory: [{ kind: 'account_row', id, revision: 0 }] }).success).toBe(true);
  });
  it('admits only canonical builtin private membership through the closed attachment operation', () => {
    const builtin = ProfileRecordV1Schema.parse({ ...record, id: 'azure-openai',
      definition: { kind: 'legacy', profile: getBuiltInBackendProfile('azure-openai') } });
    const mutation = { id: builtin.id, operation: 'attach-builtin', expectedRevision: 'absent', content: { t: 'plain', v: builtin }, referencedSavedSecretIds: [] };
    expect(ProfileRowMutationV1Schema.safeParse(mutation).success).toBe(true);
    expect(ProfileRowMutationV1Schema.safeParse({ ...mutation, content: { t: 'plain', v: { ...builtin, definition: { ...builtin.definition, profile: { ...getBuiltInBackendProfile('azure-openai'), name: 'Changed readonly preset' } } } } }).success).toBe(false);
  });
  it('does not admit an ordinary new inline Profile over a reserved historical builtin identity', () => {
    const builtinId = 'azure-openai';
    expect(ProfileRowMutationV1Schema.safeParse({ id: builtinId, operation: 'create', expectedRevision: 'absent', referencedSavedSecretIds: [],
      content: { t: 'plain', v: { ...record, id: builtinId, definition: { ...record.definition, profile: { ...record.definition.profile, id: builtinId } } } } }).success).toBe(false);
  });
  it('captures absent Profile transfer authority on the canonical Settings write', () => {
    expect(AccountSettingsV2UpdateRequestSchema.safeParse({ content: null, expectedVersion: 1,
      expectedProfileTransferRevision: 'absent' }).success).toBe(true);
  });
  it('admits only the complete captured Provider conversion transaction, not an arbitrary Settings write', () => {
    const mutation = { operation: 'provider-conversion', expectedAccountMode: 'plain', expectedSettingsVersion: 2,
      expectedProfileTransferRevision: 3, expectedReferenceGuardRevision: 4,
      profileCensus: [{ id: record.id, revision: 1 }], nextSettings: { t: 'plain', v: { themePreference: 'light' } },
      providerMutation: { expectedRevision: 7, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 },
        referencedSavedSecretIds: [], savedSecretRevisions: [] },
      mutations: [{ id: record.id, operation: 'update', expectedRevision: 1, content: { t: 'plain', v: record } }],
    };
    expect(ProfileProviderConversionMutationV1Schema.safeParse(mutation).success).toBe(true);
    expect(ProfileProviderConversionMutationV1Schema.safeParse({ ...mutation, providerMutation: undefined }).success).toBe(false);
    expect(ProfileProviderConversionMutationV1Schema.safeParse({ ...mutation, profileCensus: undefined }).success).toBe(false);
    expect(ProfileProviderConversionMutationV1Schema.safeParse({ ...mutation, mutations: [{ ...mutation.mutations[0], operation: 'create', expectedRevision: 'absent' }] }).success).toBe(false);
  });
  it('accepts captured resource revisions in the Profile semantic mutation', () => {
    expect(ProfileRowMutationV1Schema.safeParse({ id: record.id, operation: 'update', expectedRevision: 1,
      content: { t: 'plain', v: record }, referencedSavedSecretIds: [],
      savedSecretRevisions: [{ resourceId: 'resource-a', expectedRevision: 2 }],
    }).success).toBe(true);
  });
  it('admits only an addressed Artifact capture for its private attachment, not an unrelated or removed definition', () => {
    const artifactRecord = { ...record, definition: { kind: 'artifact', artifactId: 'profile-artifact' },
      secretBindings: { API_KEY: null } };
    const mutation = { id: record.id, operation: 'create', expectedRevision: 'absent',
      content: { t: 'plain', v: artifactRecord }, referencedSavedSecretIds: [],
      artifactRevision: { artifactId: 'profile-artifact', headerVersion: 2, bodyVersion: 3 } };
    expect(ProfileRowMutationV1Schema.safeParse(mutation).success).toBe(true);
    expect(ProfileRowMutationV1Schema.safeParse({ ...mutation,
      artifactRevision: { ...mutation.artifactRevision, artifactId: 'another-artifact' } }).success).toBe(false);
    expect(ProfileRowMutationV1Schema.safeParse({ ...mutation, artifactRevision: null }).success).toBe(false);
    expect(ProfileRowMutationV1Schema.safeParse({ ...mutation,
      artifactRevision: { ...mutation.artifactRevision, futureAuthority: true } }).success).toBe(false);
    expect(ProfileRowMutationV1Schema.safeParse({ ...mutation, operation: 'remove', expectedRevision: 1,
      content: null }).success).toBe(false);
    expect(ProfileRowMutationV1Schema.safeParse({ ...mutation, content: { t: 'plain', v: record },
      artifactRevision: null }).success).toBe(true);
    expect(ProfileRowMutationV1Schema.safeParse({ ...mutation, content: { t: 'plain', v: record } }).success).toBe(false);
  });
  it.each(['same-body', 'reordered-body', 'changed-body', 'injected-default', 'wrong-artifact', 'missing'] as const)(
    'keeps a readonly logical body immutable while admitting its exact addressed publication (%s)', state => {
      const previous = ProfileRecordV1Schema.parse({ v: 1, id: 'gemini-api-key',
        definition: { kind: 'legacy', profile: getHistoricalBuiltInAiLaunchProfileV1('gemini-api-key') },
        enabled: false, secretBindings: { GEMINI_API_KEY: 'shared:private-resource' },
        promptStack: [{ id: 'private-prompt', ref: { kind: 'doc', artifactId: 'private-doc' }, enabled: true, placement: 'system_append' }] });
      if (previous.definition.kind !== 'legacy') throw new Error('Expected retained readonly fixture');
      const next = ProfileRecordV1Schema.parse({ ...previous, definition: { kind: 'artifact', artifactId: 'published-profile' } });
      const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
        profile: { ...previous.definition.profile, ...(state === 'changed-body' ? { authMode: 'machineLogin' } : {}),
          ...(state === 'reordered-body' ? { compatibilityByTargetKey:
            Object.fromEntries(Object.entries(previous.definition.profile.compatibilityByTargetKey).reverse()) } : {}) },
        secretBindings: state === 'injected-default' ? { GEMINI_API_KEY: 'shared:another-resource' } : {} });
      const artifact: ArtifactSharingResourceV1 = { artifactId: state === 'wrong-artifact' ? 'another-artifact' : 'published-profile',
        header: buildLaunchProfileArtifactHeaderV1(content), body: JSON.stringify(content), revision: { headerVersion: 1, bodyVersion: 1 } };
      // An optional third input is structurally callable before the owner learns
      // the new semantic proof, so RED exercises its real wrapper-only refusal.
      const compare: (left: ProfileRecordV1, right: ProfileRecordV1, resource?: ArtifactSharingResourceV1) => boolean
        = hasChangedReadonlyProfileDefinitionV1;
      expect(compare(previous, next, state === 'missing' ? undefined : artifact))
        .toBe(state !== 'same-body' && state !== 'reordered-body');
    },
  );
  it('rejects malformed environment slots and noncanonical saved-secret references', () => {
    expect(ProfileRecordV1Schema.safeParse({ ...record, secretBindings: { 'bad-name': 'secret' } }).success).toBe(false);
    expect(ProfileRecordV1Schema.safeParse({ ...record, secretBindings: { API_KEY: ' secret ' } }).success).toBe(false);
    expect(ProfileRecordV1Schema.safeParse({ ...record, secretBindings: { API_KEY: 'happier:shared-secret:v1:' } }).success).toBe(false);
    expect(ProfileRecordV1Schema.safeParse({ ...record, secretBindings: { API_KEY: 'shared:resource-a' } }).success).toBe(true);
  });
  it('retains explicit none as a private binding override through both Account envelopes', () => {
    const privateAttachment = { ...record, definition: { kind: 'artifact', artifactId: 'profile-artifact' },
      secretBindings: { API_KEY: null, OTHER_KEY: 'shared:resource-a' } };
    const admitted = ProfileRecordV1Schema.parse(privateAttachment);
    expect(admitted.secretBindings).toEqual(privateAttachment.secretBindings);
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    for (const mode of ['plain', 'e2ee'] as const) {
      const modeMaterial = mode === 'plain' ? null : material;
      const content = sealProfileRecordContentV1({ mode, material: modeMaterial, record: admitted,
        randomBytes: length => new Uint8Array(length).fill(3) });
      expect(openProfileRecordContentV1({ mode, material: modeMaterial, expectedId: admitted.id, content }))
        .toEqual({ status: 'opened', record: admitted });
    }
  });
  it('authenticates a dedicated Account Profile cipher purpose independently of Account Settings', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    // The allocation must exist before a Profile envelope can enter the live path.
    const kind = 'account_profile_record' as AccountScopedBlobKind;
    const ciphertext = sealAccountScopedBlobCiphertext({ kind, material, payload: record, randomBytes: length => new Uint8Array(length).fill(3) });
    expect(openAccountScopedBlobCiphertext({ kind, material, ciphertext })?.value).toEqual(record);
    expect(openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext })).toBeNull();
  });
  it('refuses a definition that identifies another addressed Profile', () => {
    expect(ProfileRecordV1Schema.safeParse({ ...record, id: 'profile-b' }).success).toBe(false);
    expect(StoredProfileRecordV1Schema.safeParse({ ...record, id: 'profile-b' }).success).toBe(false);
  });

  it('opens additive nested fields but emits only the canonical known definition', () => {
    const stored = { ...record, future: true, definition: {
      ...record.definition, future: 'drop', profile: { ...record.definition.profile, future: { extra: true } },
    } };
    expect(ProfileRecordV1Schema.safeParse(stored).success).toBe(false);
    const opened = StoredProfileRecordV1Schema.parse(stored);
    expect(opened).toEqual(record);
    expect(ProfileRecordV1Schema.parse(opened)).toEqual(record);
  });
  it('refuses an identifiable SavedSecret carrier hidden in an additive stored field before projection', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const hidden = { ...record, future: { bootstrapCredentialRef: 'future-secret' } };
    expect(openProfileRecordContentV1({ mode: 'plain', material: null, expectedId: record.id,
      content: { t: 'plain', v: hidden },
    })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(openProfileRecordContentV1({ mode: 'e2ee', material, expectedId: record.id,
      content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_profile_record', material,
        payload: hidden, randomBytes: length => new Uint8Array(length).fill(3) }) },
    })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(openProfileRecordContentV1({ mode: 'plain', material: null, expectedId: record.id,
      content: { t: 'plain', v: { ...record, future: { label: 'unrelated' } } },
    })).toEqual({ status: 'opened', record });
  });
});

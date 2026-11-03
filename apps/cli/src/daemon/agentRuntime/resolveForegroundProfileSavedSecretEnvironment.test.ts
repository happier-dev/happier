import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';

import {
  ForegroundProfileSecretRecoveryRequiredError,
  resolveEffectiveLaunchProfileSecretBindings,
  resolveForegroundProfileSavedSecretEnvironment,
} from './resolveForegroundProfileSavedSecretEnvironment';

const profile = AIBackendProfileSchema.parse({
  id: 'shared-profile',
  name: 'Shared profile',
  envVarRequirements: [{ name: 'ANTHROPIC_API_KEY', required: true }],
});

describe('resolveForegroundProfileSavedSecretEnvironment', () => {
  it('consumes the admitted launch materializer for a selected profile binding', () => {
    const secretId = 'happier:shared-secret:v1:admitted-profile';
    const materializer = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
      resourceId: 'admitted-profile', ownerAccountId: 'owner', displayName: 'Profile', kind: 'apiKey',
      encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'admitted-profile', mode: 'plain',
        content: { v: 1, name: 'Profile', kind: 'apiKey', value: 'admitted-key' } }),
    }] });
    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile: { ...profile, secretBindings: { ANTHROPIC_API_KEY: secretId } }, accountSettings: {},
      settingsSecretsReadKeys: [], foregroundSatisfiedSecretRequirementNames: [], savedSecretMaterializer: materializer,
    })).toEqual({ ANTHROPIC_API_KEY: 'admitted-key' });
  });
  it('uses destination binding authority without restoring retained Settings bindings', () => {
    const admittedProfile = { ...profile, profileRecordRevision: 4,
      secretBindings: { ANTHROPIC_API_KEY: 'happier:shared-secret:v1:current' } };
    expect(resolveEffectiveLaunchProfileSecretBindings({ profile: admittedProfile,
      accountSettings: { secretBindingsByProfileId: { [profile.id]: { ANTHROPIC_API_KEY: 'stale-reference' } } } }))
      .toEqual({ ANTHROPIC_API_KEY: { ref: 'happier:shared-secret:v1:current' } });
  });
  it('materializes a ready shared Saved Secret and fails closed after revocation', () => {
    const resourceId = 'shared-profile-resource';
    const secretId = `happier:shared-secret:v1:${resourceId}`;
    const accountSettings = {
      profiles: [profile],
      secretBindingsByProfileId: {
        [profile.id]: { ANTHROPIC_API_KEY: secretId },
      },
    };
    const resource = {
      resourceId,
      ownerAccountId: 'owner-account',
      displayName: 'Shared profile key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 2,
      materialStatus: 'ready' as const,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1, name: 'Shared profile key', kind: 'apiKey', value: 'shared-profile-key' },
      }),
    };

    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings,
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: [resource],
    })).toEqual({ ANTHROPIC_API_KEY: 'shared-profile-key' });

    expect(() => resolveForegroundProfileSavedSecretEnvironment({
      profile, accountSettings, settingsSecretsReadKeys: [], foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: [resource], isCurrent: () => false,
    })).toThrow(ForegroundProfileSecretRecoveryRequiredError);

    expect(() => resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings,
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: [{ ...resource, materialStatus: 'access_removed', storedContent: null }],
    })).toThrow(ForegroundProfileSecretRecoveryRequiredError);
  });
});

import { describe, expect, it } from 'vitest';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import {
  AIBackendProfileSchema,
  SecretReferenceOverlayV1Schema,
  sealSavedSecretResourceStoredContentV1,
  type SecretReferenceOverlayV1,
} from '@happier-dev/protocol';

import {
  LaunchSecretReferenceOverlayError,
  readForegroundProfileRequiredSecretNamesMissingBinding,
  resolveForegroundProfileSavedSecretEnvironment,
  resolveSecretReferenceOverlayEnvironment,
  resolveProjectSecretReferenceEnvironment,
} from './resolveForegroundProfileSavedSecretEnvironment';

const profile = AIBackendProfileSchema.parse({
  id: 'shared-profile',
  name: 'Shared profile',
  envVarRequirements: [
    { name: 'ANTHROPIC_API_KEY', required: true },
    { name: 'OPENAI_API_KEY', required: true },
    { name: 'HAPPIER_REGION', kind: 'config', required: false },
  ],
});

function sharedResource(input: Readonly<{
  resourceId: string;
  revision: number;
  value: string;
  materialStatus?: 'ready' | 'access_removed';
}>) {
  return {
    resourceId: input.resourceId,
    ownerAccountId: 'owner-account',
    displayName: `Key ${input.resourceId}`,
    kind: 'apiKey' as const,
    encryptionMode: 'plain' as const,
    revision: input.revision,
    materialStatus: (input.materialStatus ?? 'ready') as 'ready' | 'access_removed',
    storedContent: sealSavedSecretResourceStoredContentV1({
      resourceId: input.resourceId,
      mode: 'plain',
      content: { v: 1, name: `Key ${input.resourceId}`, kind: 'apiKey', value: input.value },
    }),
  };
}

const profileResource = sharedResource({ resourceId: 'profile-bound', revision: 2, value: 'profile-value' });
const overlayResource = sharedResource({ resourceId: 'overlay-bound', revision: 7, value: 'overlay-value' });
const untouchedResource = sharedResource({ resourceId: 'untouched', revision: 1, value: 'untouched-value' });

const profileBoundRef = 'happier:shared-secret:v1:profile-bound';
const overlayBoundRef = 'happier:shared-secret:v1:overlay-bound';
const untouchedRef = 'happier:shared-secret:v1:untouched';

function accountSettings() {
  return {
    profiles: [profile],
    secretBindingsByProfileId: {
      [profile.id]: {
        ANTHROPIC_API_KEY: profileBoundRef,
        OPENAI_API_KEY: untouchedRef,
      },
    },
  };
}

const resources = [profileResource, overlayResource, untouchedResource];

function overlay(bindings: Record<string, { ref: string; revision?: number }>) {
  return SecretReferenceOverlayV1Schema.parse({ v: 1, bindings });
}

describe('resolveForegroundProfileSavedSecretEnvironment secret reference overlay', () => {
  it('overrides only the bound requirement and leaves the Profile binding for the rest', () => {
    const settings = accountSettings();
    const before = JSON.stringify(settings);

    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: settings,
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: resources,
      secretReferenceOverlay: overlay({
        ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
      }),
    })).toEqual({
      ANTHROPIC_API_KEY: 'overlay-value',
      OPENAI_API_KEY: 'untouched-value',
    });

    // The overlay is a launch override, never a Profile write.
    expect(JSON.stringify(settings)).toEqual(before);
  });

  it('preserves opaque whitespace in Profile and Run materialization', () => {
    const exactProfileValue = '  profile-value\n';
    const exactRunValue = '\t run-value  ';
    const exactResources = [
      sharedResource({ resourceId: 'profile-bound', revision: 2, value: exactProfileValue }),
      sharedResource({ resourceId: 'overlay-bound', revision: 7, value: exactRunValue }),
      untouchedResource,
    ];

    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: accountSettings(),
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: exactResources,
      secretReferenceOverlay: overlay({
        ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
      }),
    })).toEqual({
      ANTHROPIC_API_KEY: exactRunValue,
      OPENAI_API_KEY: 'untouched-value',
    });

    expect(resolveSecretReferenceOverlayEnvironment({
      accountSettings: accountSettings(),
      settingsSecretsReadKeys: [],
      savedSecretResources: exactResources,
      secretReferenceOverlay: overlay({
        ANTHROPIC_API_KEY: { ref: profileBoundRef, revision: 2 },
      }),
    })).toEqual({ ANTHROPIC_API_KEY: exactProfileValue });
  });

  it('preserves opaque whitespace from a stored personal Saved Secret', () => {
    const exactValue = '  personal-value\n';
    const settings = {
      ...accountSettings(),
      secrets: [{
        id: 'personal-secret', name: 'Personal', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true as const, value: exactValue },
        createdAt: 1, updatedAt: 1,
      }],
      secretBindingsByProfileId: {
        [profile.id]: { ANTHROPIC_API_KEY: 'personal-secret', OPENAI_API_KEY: untouchedRef },
      },
    };

    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: settings,
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: resources,
    }).ANTHROPIC_API_KEY).toBe(exactValue);

    expect(resolveSecretReferenceOverlayEnvironment({
      accountSettings: settings,
      settingsSecretsReadKeys: [],
      secretReferenceOverlay: overlay({ ANTHROPIC_API_KEY: { ref: 'personal-secret' } }),
    })).toEqual({ ANTHROPIC_API_KEY: exactValue });
  });

  it('preserves the incumbent result when no overlay is supplied', () => {
    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: accountSettings(),
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: resources,
    })).toEqual({
      ANTHROPIC_API_KEY: 'profile-value',
      OPENAI_API_KEY: 'untouched-value',
    });
  });

  it('binds a requirement that has no Profile binding at all', () => {
    const settings = { profiles: [profile], secretBindingsByProfileId: {} };
    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: settings,
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: ['OPENAI_API_KEY'],
      savedSecretResources: resources,
      secretReferenceOverlay: overlay({
        ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
      }),
    })).toEqual({ ANTHROPIC_API_KEY: 'overlay-value' });
  });

  it('rejects a stale admitted revision instead of silently using current material', () => {
    let thrown: unknown;
    try {
      resolveForegroundProfileSavedSecretEnvironment({
        profile,
        accountSettings: accountSettings(),
        settingsSecretsReadKeys: [],
        foregroundSatisfiedSecretRequirementNames: [],
        savedSecretResources: resources,
        secretReferenceOverlay: overlay({
          ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 6 },
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LaunchSecretReferenceOverlayError);
    expect((thrown as LaunchSecretReferenceOverlayError).reason).toBe('reference_stale');
    expect((thrown as LaunchSecretReferenceOverlayError).requirementName).toBe('ANTHROPIC_API_KEY');
  });

  it('rejects an unresolvable reference instead of falling back to the Profile binding', () => {
    let thrown: unknown;
    try {
      resolveForegroundProfileSavedSecretEnvironment({
        profile,
        accountSettings: accountSettings(),
        settingsSecretsReadKeys: [],
        foregroundSatisfiedSecretRequirementNames: [],
        savedSecretResources: [
          profileResource,
          { ...overlayResource, materialStatus: 'access_removed' as const, storedContent: null },
          untouchedResource,
        ],
        secretReferenceOverlay: overlay({
          ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LaunchSecretReferenceOverlayError);
    expect((thrown as LaunchSecretReferenceOverlayError).reason).toBe('reference_forbidden');
  });

  it('keeps an admitted current revision unavailable rather than misclassifying it as stale', () => {
    let thrown: unknown;
    try {
      resolveForegroundProfileSavedSecretEnvironment({
        profile,
        accountSettings: accountSettings(),
        settingsSecretsReadKeys: [],
        foregroundSatisfiedSecretRequirementNames: [],
        savedSecretResources: [
          profileResource,
          {
            ...overlayResource,
            materialStatus: 'temporarily_unavailable' as const,
            storedContent: null,
          },
          untouchedResource,
        ],
        secretReferenceOverlay: overlay({
          ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LaunchSecretReferenceOverlayError);
    expect((thrown as LaunchSecretReferenceOverlayError).reason)
      .toBe('reference_unavailable');
  });

  it('rejects a requirement name the selected Profile does not declare as a secret', () => {
    for (const name of ['UNDECLARED_KEY', 'HAPPIER_REGION']) {
      let thrown: unknown;
      try {
        resolveForegroundProfileSavedSecretEnvironment({
          profile,
          accountSettings: accountSettings(),
          settingsSecretsReadKeys: [],
          foregroundSatisfiedSecretRequirementNames: [],
          savedSecretResources: resources,
          secretReferenceOverlay: overlay({ [name]: { ref: overlayBoundRef, revision: 7 } }),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LaunchSecretReferenceOverlayError);
      expect((thrown as LaunchSecretReferenceOverlayError).reason).toBe('undeclared_requirement');
      expect((thrown as LaunchSecretReferenceOverlayError).requirementName).toBe(name);
    }
  });

  it('resolves several overridden requirements in one launch', () => {
    expect(resolveForegroundProfileSavedSecretEnvironment({
      profile,
      accountSettings: accountSettings(),
      settingsSecretsReadKeys: [],
      foregroundSatisfiedSecretRequirementNames: [],
      savedSecretResources: resources,
      secretReferenceOverlay: overlay({
        ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
        OPENAI_API_KEY: { ref: profileBoundRef, revision: 2 },
      }),
    })).toEqual({
      ANTHROPIC_API_KEY: 'overlay-value',
      OPENAI_API_KEY: 'profile-value',
    });
  });
});

describe('resolveSecretReferenceOverlayEnvironment', () => {
  it('preserves the catalog mode-mismatch reason without exposing plaintext', () => {
    const binding = overlay({ ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 } });
    const resource = {
      ...overlayResource,
      materialStatus: 'recipient_mode_unsupported' as const,
      storedContent: null,
    };
    for (const resolve of [
      () => resolveSecretReferenceOverlayEnvironment({ accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: [resource], secretReferenceOverlay: binding }),
      () => resolveForegroundProfileSavedSecretEnvironment({ profile, accountSettings: {}, settingsSecretsReadKeys: [], foregroundSatisfiedSecretRequirementNames: [], savedSecretResources: [resource], secretReferenceOverlay: binding }),
      () => resolveProjectSecretReferenceEnvironment({ requirements: profile.envVarRequirements ?? [], accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: [resource], secretReferenceOverlay: binding }),
    ]) {
      let failure: unknown;
      try { resolve(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ reason: 'reference_mode_incompatible', requirementName: 'ANTHROPIC_API_KEY' });
      expect(String(failure)).not.toContain('overlay-value');
    }
  });

  it('refuses wrong and missing shared revisions identically for Profile, Run and Project', () => {
    for (const revision of [6, undefined]) {
      const binding: SecretReferenceOverlayV1 = { v: 1, bindings: { ANTHROPIC_API_KEY: { ref: overlayBoundRef, ...(revision === undefined ? {} : { revision }) } } };
      for (const resolve of [
        () => resolveSecretReferenceOverlayEnvironment({ accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: resources, secretReferenceOverlay: binding }),
        () => resolveForegroundProfileSavedSecretEnvironment({ profile, accountSettings: {}, settingsSecretsReadKeys: [], foregroundSatisfiedSecretRequirementNames: [], savedSecretResources: resources, secretReferenceOverlay: binding }),
        () => resolveProjectSecretReferenceEnvironment({ requirements: profile.envVarRequirements ?? [], accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: resources, secretReferenceOverlay: binding }),
      ]) {
        expect(resolve).toThrow(expect.objectContaining({ reason: 'reference_stale', requirementName: 'ANTHROPIC_API_KEY' }));
      }
    }
  });

  it('reads stored binding extras recursively but retains validation of exact references', () => {
    const storedSchema = createStoredReadSchema(SecretReferenceOverlayV1Schema);
    expect(storedSchema.parse({ v: 1, future: true, bindings: { ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7, future: { value: true } } } })).toEqual(overlay({ ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 } }));
    expect(storedSchema.safeParse({ v: 1, bindings: { ANTHROPIC_API_KEY: { ref: overlayBoundRef } } }).success).toBe(false);
    expect(SecretReferenceOverlayV1Schema.safeParse({ v: 1, future: true, bindings: { ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 } } }).success).toBe(false);
  });

  it('materializes Project bindings through the generic body and enforces declared required secrets', () => {
    const binding = overlay({ ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 } });
    expect(resolveProjectSecretReferenceEnvironment({ requirements: [{ name: 'ANTHROPIC_API_KEY', kind: 'secret', required: true }], accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: resources, secretReferenceOverlay: binding })).toEqual({ ANTHROPIC_API_KEY: 'overlay-value' });
    expect(() => resolveProjectSecretReferenceEnvironment({ requirements: profile.envVarRequirements ?? [], accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: resources, secretReferenceOverlay: binding })).toThrow(expect.objectContaining({ reason: 'reference_missing', requirementName: 'OPENAI_API_KEY' }));
    expect(() => resolveProjectSecretReferenceEnvironment({ requirements: [{ name: 'HAPPIER_REGION', kind: 'config', required: false }], accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: resources, secretReferenceOverlay: binding })).toThrow(expect.objectContaining({ reason: 'undeclared_requirement', requirementName: 'ANTHROPIC_API_KEY' }));
  });

  it('materializes direct Execution Run bindings without an Agent Launch Profile', () => {
    expect(resolveSecretReferenceOverlayEnvironment({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      savedSecretResources: resources,
      secretReferenceOverlay: overlay({
        ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
      }),
    })).toEqual({ ANTHROPIC_API_KEY: 'overlay-value' });
  });

  it('fails closed when a bypassing shared reference omits its revision', () => {
    const malformedOverlay = {
      v: 1,
      bindings: {
        ANTHROPIC_API_KEY: { ref: overlayBoundRef },
      },
    } as unknown as SecretReferenceOverlayV1;

    let thrown: unknown;
    try {
      resolveSecretReferenceOverlayEnvironment({
        accountSettings: {},
        settingsSecretsReadKeys: [],
        savedSecretResources: resources,
        secretReferenceOverlay: malformedOverlay,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LaunchSecretReferenceOverlayError);
    expect((thrown as LaunchSecretReferenceOverlayError).reason).toBe('reference_stale');
  });
});

describe('readForegroundProfileRequiredSecretNamesMissingBinding with an overlay', () => {
  it('does not ask the foreground for a requirement the overlay already binds', () => {
    const settings = { profiles: [profile], secretBindingsByProfileId: {} };
    expect(readForegroundProfileRequiredSecretNamesMissingBinding({
      profile,
      accountSettings: settings,
    })).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

    expect(readForegroundProfileRequiredSecretNamesMissingBinding({
      profile,
      accountSettings: settings,
      secretReferenceOverlay: overlay({
        ANTHROPIC_API_KEY: { ref: overlayBoundRef, revision: 7 },
      }),
    })).toEqual(['OPENAI_API_KEY']);
  });
});

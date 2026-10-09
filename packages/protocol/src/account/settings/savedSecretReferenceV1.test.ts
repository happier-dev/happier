import { describe, expect, it } from 'vitest';

import * as references from './savedSecretReferenceV1.js';

describe('SavedSecret raw reference carrier census', () => {
  it('distinguishes an opaque root property from the nested carrier it resembles', () => {
    expect(references.listSavedSecretReferenceCarrierPathsV1({
      v: { channels: [{ signingSecretRef: 'happier:shared-secret:v1:known' }] },
      'v.channels[0].signingSecretRef': 'happier:shared-secret:v1:hidden',
    })).toEqual(['v.channels[0].signingSecretRef', '["v.channels[0].signingSecretRef"]']);
  });

  it('does not merge an additive reference property into the canonical ValueRef carrier path', () => {
    expect(references.listSavedSecretReferenceCarrierPathsV1({ env: {
      TOKEN: { t: 'savedSecret', secretId: 'known-key', savedSecretId: 'other-key' },
    } })).toEqual(['env.TOKEN', 'env.TOKEN.savedSecretId']);
    expect(references.listSavedSecretReferenceCarrierPathsV1({ binding: { savedSecretId: 'plugin-key' } }))
      .toEqual(['binding']);
  });

  it('finds identifiable references before tolerant Profile projection can drop their carriers', () => {
    expect(references.listSavedSecretReferenceCarrierPathsV1({
      secretBindings: { TOKEN: 'personal-key' },
      definition: { profile: { futureCredential: { t: 'savedSecret', secretId: 'other-key' } } },
      managedHost: { bootstrapCredentialRef: 'happier:shared-secret:v1:bootstrap' },
      unrelated: { value: 'personal-key' },
    })).toEqual(['secretBindings.TOKEN', 'definition.profile.futureCredential', 'managedHost.bootstrapCredentialRef']);
  });

  it('distinguishes Voice identity metadata from actual binding values and supports an exact selected ref', () => {
    expect(references.listSavedSecretReferenceCarrierPathsV1({
      credentialBindings: [{
        contribution: { pluginId: 'happier.voice.fixture', localId: 'api_key' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: 'api_key' }, byMachineId: { other: { api_key: 'different' } } },
      }],
    }, { secretId: 'api_key', initialPath: 'voiceSettingsV1' })).toEqual([
      'voiceSettingsV1.credentialBindings[0].credentialBindings.account.api_key',
    ]);
  });
});

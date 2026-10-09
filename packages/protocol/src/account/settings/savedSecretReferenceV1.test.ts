import { describe, expect, it } from 'vitest';

import * as references from './savedSecretReferenceV1.js';

describe('SavedSecret raw reference carrier census', () => {
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

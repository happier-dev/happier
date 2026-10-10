import { describe, expect, it } from 'vitest';

import {
  sealSavedSecretResourceStoredContentV1,
  type SavedSecretCatalogResourceV1,
} from '@happier-dev/protocol';

import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';

import { resolveMcpValueRefPlaintext } from './resolveMcpValueRefPlaintext';

const sharedRef = 'happier:shared-secret:v1:resource_1';

function resource(
  materialStatus: SavedSecretCatalogResourceV1['materialStatus'],
): SavedSecretCatalogResourceInputV1 {
  return {
    resourceId: 'resource_1',
    ownerAccountId: 'owner',
    displayName: 'shared',
    kind: 'token',
    encryptionMode: 'plain',
    revision: 1,
    materialStatus,
    storedContent: materialStatus === 'ready' ? null : sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource_1',
      mode: 'plain',
      content: { v: 1, name: 'shared', kind: 'token', value: 'unused' },
    }),
  };
}

describe('resolveMcpValueRefPlaintext', () => {
  it('refuses a SavedSecret reference without the admitted catalog materializer', () => {
    expect(resolveMcpValueRefPlaintext({
      valueRef: { t: 'savedSecret', secretId: sharedRef },
      processEnv: {},
    })).toEqual({ status: 'temporarily_unavailable' });
  });

  it('keeps literal expansion behavior unchanged', () => {
    expect(resolveMcpValueRefPlaintext({
      valueRef: { t: 'literal', v: 'Bearer ${TOKEN}' },
      processEnv: { TOKEN: 'literal-value' },
    })).toEqual({ status: 'ready', value: 'Bearer literal-value' });

    expect(resolveMcpValueRefPlaintext({
      valueRef: { t: 'literal', v: '${MISSING}' },
      processEnv: {},
    })).toEqual({ status: 'literal_unavailable' });
  });

  it.each([
    ['missing', 'personal_missing', []],
    ['temporarily_unavailable', sharedRef, [resource('temporarily_unavailable')]],
    ['forbidden', sharedRef, [resource('access_removed')]],
    ['repair_required', sharedRef, [resource('update_required')]],
    ['deleted', sharedRef, [resource('deleted')]],
    ['mode_incompatible', sharedRef, [resource('recipient_mode_unsupported')]],
    ['corrupt', sharedRef, [resource('ready')]],
  ] as const)('preserves Saved Secret status %s', (expectedStatus, secretId, resources) => {
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resources,
      resourceCatalogState: 'ready',
    });

    expect(resolveMcpValueRefPlaintext({
      valueRef: { t: 'savedSecret', secretId },
      savedSecretMaterializer,
      processEnv: {},
    })).toEqual({ status: expectedStatus });
  });
});

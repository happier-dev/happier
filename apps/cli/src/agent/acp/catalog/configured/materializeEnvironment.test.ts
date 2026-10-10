import { describe, expect, it } from 'vitest';
import {
  formatSharedSavedSecretRefV1,
  sealSavedSecretResourceStoredContentV1,
  type SavedSecret,
  type SavedSecretCatalogResourceV1,
} from '@happier-dev/protocol';

import type { SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';
import { materializeConfiguredAcpEnvironment } from './materializeEnvironment';

function backend(secretId: string): ResolvedConfiguredAcpBackend {
  return {
    backendId: 'plain-acp',
    source: { kind: 'account_configured' },
    name: 'plain-acp',
    title: 'Plain ACP',
    command: 'plain-acp',
    args: [],
    env: {
      ACP_TOKEN: { t: 'savedSecret', secretId },
    },
    capabilities: {
      supportsLoadSession: false,
      supportsModes: 'unknown',
      supportsModels: 'unknown',
      supportsConfigOptions: 'unknown',
      promptImageSupport: 'unknown',
    },
  };
}

function savedSecret(encryptedValue: SavedSecret['encryptedValue']): SavedSecret {
  return {
    id: 'secret-acp',
    name: 'ACP token',
    kind: 'token',
    encryptedValue,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('materializeConfiguredAcpEnvironment', () => {
  it.each([
    ['temporarily_unavailable', 'happier:shared-secret:v1:resource_1', 'temporarily_unavailable'],
    ['forbidden', 'happier:shared-secret:v1:resource_1', 'access_removed'],
    ['repair_required', 'happier:shared-secret:v1:resource_1', 'update_required'],
    ['deleted', 'happier:shared-secret:v1:resource_1', 'deleted'],
    ['mode_incompatible', 'happier:shared-secret:v1:resource_1', 'recipient_mode_unsupported'],
    ['corrupt', 'happier:shared-secret:v1:resource_1', 'ready'],
  ] as const)('preserves Saved Secret status %s in configured ACP launch failures', (
    expectedStatus,
    secretId,
    materialStatus,
  ) => {
    const savedSecretResources: SavedSecretCatalogResourceInputV1[] = [{
      resourceId: 'resource_1',
      ownerAccountId: 'owner',
      displayName: 'shared',
      kind: 'token',
      encryptionMode: 'plain',
      revision: 1,
      materialStatus: materialStatus satisfies SavedSecretCatalogResourceV1['materialStatus'],
      storedContent: materialStatus === 'ready' ? null : sealSavedSecretResourceStoredContentV1({
        resourceId: 'resource_1',
        mode: 'plain',
        content: { v: 1, name: 'shared', kind: 'token', value: 'unused' },
      }),
    }];

    try {
      materializeConfiguredAcpEnvironment({
        backend: backend(secretId),
        accountSettings: {},
        credentials: { token: 'plain-account', encryption: null },
        processEnv: {},
        savedSecretResources,
      });
      throw new Error('expected configured ACP materialization to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'saved_secret_resolution_failed',
        status: expectedStatus,
        consumer: 'acp',
        field: 'env:ACP_TOKEN',
      });
    }
  });

  it('refuses a personal source credential instead of falling back to the legacy Settings root', () => {
    const credentials = {
      token: 'token-only',
      encryption: null,
    };

    expect(() => materializeConfiguredAcpEnvironment({
      backend: backend('secret-acp'),
      accountSettings: {
        secrets: [savedSecret({ _isSecretValue: true, value: 'plain-account-secret' })],
      },
      credentials,
      processEnv: {},
    })).toThrow(expect.objectContaining({ code: 'saved_secret_resolution_failed', status: 'repair_required', consumer: 'acp' }));
  });

  it('materializes a shared Saved Secret through the configured ACP launch owner', () => {
    const resourceId = 'shared-acp-resource';
    const secretId = formatSharedSavedSecretRefV1(resourceId);

    expect(materializeConfiguredAcpEnvironment({
      backend: backend(secretId),
      accountSettings: {},
      credentials: { token: 'plain-account', encryption: null },
      processEnv: {},
      savedSecretResources: [{
        resourceId,
        ownerAccountId: 'owner-account',
        displayName: 'Shared ACP token',
        kind: 'token',
        encryptionMode: 'plain',
        revision: 4,
        materialStatus: 'ready',
        storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId,
          mode: 'plain',
          content: { v: 1, name: 'Shared ACP token', kind: 'token', value: 'shared-acp-token' },
        }),
      }],
    })).toEqual({ ACP_TOKEN: 'shared-acp-token' });
  });
});

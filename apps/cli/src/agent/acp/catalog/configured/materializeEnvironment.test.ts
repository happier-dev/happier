import { describe, expect, it } from 'vitest';
import {
  formatSharedSavedSecretRefV1,
  sealSavedSecretResourceStoredContentV1,
  type SavedSecret,
  type SavedSecretCatalogResourceV1,
} from '@happier-dev/protocol';

import { createSavedSecretMaterializerV1, type SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';
import { materializeConfiguredAcpEnvironment } from './materializeEnvironment';

function backend(secretId: string): ResolvedConfiguredAcpBackend {
  return {
    backendId: 'plain-acp',
    source: { kind: 'account_configured' },
    name: 'plain-acp',
    title: 'Plain ACP',
    launch: { kind: 'command', command: 'plain-acp', args: [] },
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
  it('uses admitted material for a template without rebuilding a catalog', () => {
    const secretId = formatSharedSavedSecretRefV1('admitted-acp');
    const materializer = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources: [{
      resourceId: 'admitted-acp', ownerAccountId: 'owner', displayName: 'ACP', kind: 'token',
      relationship: 'owner', capabilities: { use: true },
      encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'admitted-acp', mode: 'plain',
        content: { v: 2, name: 'ACP', kind: 'token', source: { kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'main' },
          account: 'account', reference: 'op://vault/item/field' } } }),
    }], externalAcquisitions: new Map([[secretId, { status: 'ready', value: 'admitted-token' }]]) });
    expect(materializeConfiguredAcpEnvironment({ backend: { ...backend(secretId), env: {
      ACP_TOKEN: { t: 'template', template: 'Bearer {token}', vars: { token: { t: 'savedSecret', secretId } } },
    } }, accountSettings: {}, processEnv: {}, savedSecretMaterializer: materializer })).toEqual({ ACP_TOKEN: 'Bearer admitted-token' });
  });
  it.each([
    ['secret-acp', 'repair_required'], ['happier:shared-secret:v1:resource_1', 'deleted'],
  ] as const)('keeps ACP template secret authority and typed failure for %s', (secretId, status) => {
    const definition = backend(secretId);
    expect(() => materializeConfiguredAcpEnvironment({
      backend: { ...definition, env: { ACP_TOKEN: { t: 'template', template: 'Bearer {key}',
        vars: { key: { t: 'savedSecret', secretId } },
      } } },
      accountSettings: { secrets: [savedSecret({ _isSecretValue: true, value: 'personal-acp-token' })] },
      credentials: { token: 'plain-account', encryption: null }, processEnv: {},
      savedSecretResources: [{ resourceId: 'resource_1', ownerAccountId: 'owner', displayName: 'key', kind: 'token',
        encryptionMode: 'plain', revision: 1, materialStatus: 'deleted', storedContent: null }],
    })).toThrow(expect.objectContaining({ code: 'saved_secret_resolution_failed', status, reference: secretId,
      consumer: 'acp', field: 'env:ACP_TOKEN' }));
  });
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

  it('materializes a private personal resource through the configured ACP launch owner', () => {
    const resourceId = 'private-acp-resource';
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
        relationship: 'owner',
        capabilities: { use: true },
        storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId,
          mode: 'plain',
          content: { v: 1, name: 'Shared ACP token', kind: 'token', value: 'shared-acp-token' },
        }),
      }],
    })).toEqual({ ACP_TOKEN: 'shared-acp-token' });
  });
});

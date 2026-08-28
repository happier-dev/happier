import { describe, expect, it } from 'vitest';
import {
  encryptSecretStringV1,
  type SavedSecret,
} from '@happier-dev/protocol';

import { deriveSettingsSecretsKeyForCredentials } from '@/settings/secrets/settingsSecretsKey';
import type { Credentials, TokenOnlyCredentials } from '@/persistence';

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
  it('reads plaintext Saved Secrets with token-only credentials and no fabricated key', () => {
    const credentials: TokenOnlyCredentials = {
      token: 'token-only',
      encryption: null,
    };

    expect(materializeConfiguredAcpEnvironment({
      backend: backend('secret-acp'),
      accountSettings: {
        secrets: [savedSecret({ _isSecretValue: true, value: 'plain-account-secret' })],
      },
      credentials,
      processEnv: {},
    })).toEqual({
      ACP_TOKEN: 'plain-account-secret',
    });
  });

  it('keeps encrypted Saved Secrets unavailable without their real E2EE material', () => {
    const e2eeCredentials: Credentials = {
      token: 'e2ee',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
    };
    const encryptedValue = encryptSecretStringV1(
      'retained-e2ee-secret',
      deriveSettingsSecretsKeyForCredentials(e2eeCredentials),
      (length) => new Uint8Array(length).fill(2),
    );
    const accountSettings = {
      secrets: [savedSecret({ _isSecretValue: true, encryptedValue })],
    };

    expect(() => materializeConfiguredAcpEnvironment({
      backend: backend('secret-acp'),
      accountSettings,
      credentials: { token: 'token-only', encryption: null },
      processEnv: {},
    })).toThrow('Missing ACP backend value for env:ACP_TOKEN');
    expect(accountSettings.secrets[0]?.encryptedValue).toEqual({
      _isSecretValue: true,
      encryptedValue,
    });
  });
});

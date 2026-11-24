import { describe, expect, it } from 'vitest';
import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol';

import { createConnectedAccountCredentialRedaction } from './credentialRedaction.js';

const deviceMode = {
  id: 'device',
  kind: 'oauthDeviceCode',
  title: 'Sign in',
  scopes: [],
  outcomeReconciliation: 'none',
} as unknown as PluginConnectedAccountAuthenticationModeV2;

const manualMode = {
  id: 'api-key',
  kind: 'manual',
  title: 'API key',
  outcomeReconciliation: 'none',
  fields: [
    {
      id: 'apiKey',
      title: 'API key',
      schema: { type: 'string', minLength: 1 },
      secret: true,
    },
    {
      id: 'source',
      title: 'Source',
      schema: { type: 'string', enum: ['native'] },
      secret: false,
    },
  ],
} as unknown as PluginConnectedAccountAuthenticationModeV2;

describe('createConnectedAccountCredentialRedaction secret values', () => {
  it('returns only secret credential values, never metadata modes, ids or labels', () => {
    const redaction = createConnectedAccountCredentialRedaction({
      mode: deviceMode,
      credential: {
        v: 1,
        values: {
          accessToken: 'dummy-access-secret',
          refreshToken: 'dummy-refresh-secret',
          credentialMode: 'native',
          tokenType: 'Bearer',
          providerAccountId: 'acct-1',
          expiresAtMs: '1700000000000',
        },
      },
      configuration: {},
      configurationSecrets: { clientSecret: 'dummy-client-secret' },
    });
    const values = redaction.readSecretValues();
    expect(values).toEqual(
      expect.arrayContaining([
        'dummy-access-secret',
        'dummy-refresh-secret',
        'dummy-client-secret',
      ]),
    );
    for (const metadata of ['native', 'Bearer', 'acct-1', '1700000000000'])
      expect(values).not.toContain(metadata);
  });

  it('returns a manual mode only for the fields its descriptor marks secret', () => {
    const redaction = createConnectedAccountCredentialRedaction({
      mode: manualMode,
      credential: {
        v: 1,
        values: { apiKey: 'dummy-manual-api-key', source: 'native' },
      },
      configuration: {},
    });
    const values = redaction.readSecretValues();
    expect(values).toContain('dummy-manual-api-key');
    expect(values).not.toContain('native');
  });

  it('returns a value read through Saved Secret custody', () => {
    const redaction = createConnectedAccountCredentialRedaction({
      mode: deviceMode,
      credential: { v: 1, values: { credentialMode: 'native' } },
      configuration: {},
    });
    redaction.observeSecret('dummy-saved-secret-value');
    expect(redaction.readSecretValues()).toContain('dummy-saved-secret-value');
    expect(redaction.readSecretValues()).not.toContain('native');
  });
});

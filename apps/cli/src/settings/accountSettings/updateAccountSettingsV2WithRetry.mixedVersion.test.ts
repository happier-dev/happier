import { describe, expect, it, vi } from 'vitest';

import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import { updateAccountSettingsV2WithRetry } from './updateAccountSettingsV2WithRetry';

const credentials = {
  token: 'test-token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array(32).fill(7),
  },
} satisfies Credentials;

describe('updateAccountSettingsV2WithRetry mixed-version preservation', () => {
  it('preserves newer Provider and purpose-binding bytes when an older-style mutation omits them', async () => {
    const providerSettingsV1 = {
      v: 1,
      connections: [{
        id: 'pc_managed',
        deployment: 'managed',
        purposeBindingDefaults: ['model-openai'],
      }],
      securityFingerprintsV1: { pc_managed: 'sha256:future-shape' },
    };
    const connectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
          purpose: 'model-openai',
        },
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'subscription',
            },
            accountId: 'work',
          },
        },
      }],
    };
    const updateSettings = vi.fn(async (request: Readonly<{
      expectedVersion: number;
      content: AccountSettingsStoredContentEnvelope | null;
    }>) => ({ success: true as const, version: request.expectedVersion + 1 }));

    await updateAccountSettingsV2WithRetry({
      credentials,
      // Released writers can return only fields they understand. The updater owns
      // merging that sparse mutation back into the untouched raw persisted object.
      mutate: (raw) => ({
        schemaVersion: raw.schemaVersion,
        analyticsOptOut: true,
      }),
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: {
              schemaVersion: 6,
              providerSettingsV1,
              connectedAccountPurposeBindingsV1,
            },
          },
          version: 12,
        }),
        updateSettings,
      },
    });

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings.mock.calls[0]?.[0]).toEqual({
      expectedVersion: 12,
      content: {
        t: 'plain',
        v: {
          schemaVersion: 6,
          analyticsOptOut: true,
          providerSettingsV1,
          connectedAccountPurposeBindingsV1,
        },
      },
    });
  });
});

import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  requireChannelsAccountStorage,
  requireChannelsResourceAccountStorage,
} from './requiredAccountStorage.js';

describe('requireChannelsAccountStorage', () => {
  it('fails closed when a required Channels invocation has no admitted Account storage', () => {
    expect(() => requireChannelsAccountStorage({ services: { storage: {} } })).toThrow(
      expect.objectContaining<Partial<PluginError>>({
        code: 'channels_account_storage_unavailable',
      }),
    );
  });

  it.each([
    ['connections', 'channels_connections_resource_account_storage_unavailable', 'The Channels connections Resource requires admitted Account storage.'],
    ['bindings', 'channels_bindings_resource_account_storage_unavailable', 'The Channels bindings Resource requires admitted Account storage.'],
    ['pairing', 'channels_pairing_resource_account_storage_unavailable', 'The Channels pairing Resource requires admitted Account storage.'],
    ['transcriptActivities', 'channels_transcript_activities_resource_account_storage_unavailable', 'The Channels transcript Activity Resource requires admitted Account storage.'],
  ] as const)('preserves the %s Resource error contract', (resource, code, message) => {
    expect(() => requireChannelsResourceAccountStorage(
      { accountStorage: undefined } as never,
      resource,
    )).toThrow(expect.objectContaining<Partial<PluginError>>({ code, message }));
  });
});

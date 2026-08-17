import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { requireChannelsAccountStorage } from './requiredAccountStorage.js';

describe('requireChannelsAccountStorage', () => {
  it('fails closed when a required Channels invocation has no admitted Account storage', () => {
    expect(() => requireChannelsAccountStorage({ services: { storage: {} } })).toThrow(
      expect.objectContaining<Partial<PluginError>>({
        code: 'channels_account_storage_unavailable',
      }),
    );
  });
});

import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { requireTriageAccountStorage } from './requiredAccountStorage.js';

describe('requireTriageAccountStorage', () => {
  it('fails closed when a required Triage invocation has no admitted Account storage', () => {
    expect(() => requireTriageAccountStorage({ services: { storage: {} } })).toThrow(
      expect.objectContaining<Partial<PluginError>>({
        code: 'triage_account_storage_unavailable',
      }),
    );
  });
});

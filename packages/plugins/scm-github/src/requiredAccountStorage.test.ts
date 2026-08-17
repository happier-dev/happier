import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { requireGithubAccountStorage } from './requiredAccountStorage.js';

describe('requireGithubAccountStorage', () => {
  it('fails closed when a required GitHub Automation invocation has no admitted Account storage', () => {
    expect(() => requireGithubAccountStorage({ services: { storage: {} } })).toThrow(
      expect.objectContaining<Partial<PluginError>>({
        code: 'github_account_storage_unavailable',
      }),
    );
  });
});

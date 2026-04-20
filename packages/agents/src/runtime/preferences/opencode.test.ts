import { describe, expect, it } from 'vitest';

import { resolveOpenCodeSessionRuntimePreferences } from './opencode.js';

describe('resolveOpenCodeSessionRuntimePreferences', () => {
  it('uses canonical settings when explicit runtime env overrides are absent', () => {
    expect(resolveOpenCodeSessionRuntimePreferences({
      settings: {
        opencodeBackendMode: 'acp',
        opencodeServerBaseUrl: 'http://127.0.0.1:4888/',
      },
      processEnv: {},
    })).toEqual({
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://127.0.0.1:4888/',
      opencodeServerBaseUrlExplicit: true,
    });
  });

  it('keeps persisted settings ahead of ambient runtime env values', () => {
    expect(resolveOpenCodeSessionRuntimePreferences({
      settings: {
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4888/',
      },
      processEnv: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999/',
      },
    })).toEqual({
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4888/',
      opencodeServerBaseUrlExplicit: true,
    });
  });

  it('does not fall back to ambient runtime env when canonical settings omit a server override', () => {
    expect(resolveOpenCodeSessionRuntimePreferences({
      settings: {},
      processEnv: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999/',
      },
    })).toEqual({
      opencodeBackendMode: 'server',
      opencodeServerBaseUrlExplicit: false,
    });
  });
});

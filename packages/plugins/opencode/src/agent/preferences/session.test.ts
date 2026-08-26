import { describe, expect, it } from 'vitest';

import { resolveOpenCodeSessionRuntimePreferences } from './session.js';

describe('resolveOpenCodeSessionRuntimePreferences', () => {
  it('resolves OpenCode runtime preferences from canonical settings', () => {
    expect(resolveOpenCodeSessionRuntimePreferences({
      settings: {
        opencodeBackendMode: 'acp',
        opencodeServerBaseUrl: 'http://127.0.0.1:4888/',
      },
      environment: {},
    })).toEqual({
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://127.0.0.1:4888/',
      opencodeServerBaseUrlExplicit: true,
    });
  });


  it('does not use ambient runtime env when settings omit an explicit server override', () => {
    expect(resolveOpenCodeSessionRuntimePreferences({
      settings: {},
      environment: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999/',
      },
    })).toEqual({
      opencodeBackendMode: 'server',
      opencodeServerBaseUrlExplicit: false,
    });
  });
});

import { describe, expect, it } from 'vitest';

import { resolveCodexSessionRuntimePreferences } from './runtimePreferences.js';

describe('resolveCodexSessionRuntimePreferences', () => {
  it('selects the app-server backend from account settings', () => {
    expect(resolveCodexSessionRuntimePreferences({
      settings: { codexBackendMode: 'appServer' },
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      codexBackendMode: 'appServer',
    });
  });

  it('selects the ACP backend from account settings', () => {
    expect(resolveCodexSessionRuntimePreferences({
      settings: { codexBackendMode: 'acp' },
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      codexBackendMode: 'acp',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { resolveCodexSessionRuntimePreferences } from './runtimePreferences.js';

describe('resolveCodexSessionRuntimePreferences', () => {
  it('keeps Codex app-server Pending rows claimed until exact provider acceptance', () => {
    expect(resolveCodexSessionRuntimePreferences({
      settings: { codexBackendMode: 'appServer' },
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      codexBackendMode: 'appServer',
    });
  });

  it('keeps ACP provider acceptance on the default pending delivery path', () => {
    expect(resolveCodexSessionRuntimePreferences({
      settings: { codexBackendMode: 'acp' },
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      codexBackendMode: 'acp',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { resolveCodexSessionRuntimePreferences } from './runtimePreferences.js';

describe('resolveCodexSessionRuntimePreferences', () => {
  it('uses commit-at-materialize pending delivery for Codex app-server provider acceptance', () => {
    expect(resolveCodexSessionRuntimePreferences({
      settings: { codexBackendMode: 'appServer' },
      processEnv: {},
      startedBy: 'terminal',
    })).toEqual({
      codexBackendMode: 'appServer',
      providerAcceptancePendingMaterialization: 'commitAtMaterialize',
    });
  });

  it('keeps ACP provider acceptance on the default pending delivery path', () => {
    expect(resolveCodexSessionRuntimePreferences({
      settings: { codexBackendMode: 'acp' },
      processEnv: {},
      startedBy: 'terminal',
    })).toEqual({
      codexBackendMode: 'acp',
    });
  });
});

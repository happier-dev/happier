import { describe, expect, it } from 'vitest';

import * as codexPreferences from './codex.js';

describe('resolveCodexSessionRuntimePreferences', () => {
  it('keeps persisted settings ahead of ambient runtime env values', () => {
    expect(codexPreferences.resolveCodexSessionRuntimePreferences({
      settings: {
        codexBackendMode: 'appServer',
      },
      processEnv: {
        HAPPIER_CODEX_BACKEND_MODE: 'mcp',
      },
    })).toEqual({
      codexBackendMode: 'appServer',
    });
  });

  it('does not silently enable ACP from ambient env when settings omit a Codex backend override', () => {
    expect(codexPreferences.resolveCodexSessionRuntimePreferences({
      settings: {},
      processEnv: {
        HAPPIER_CODEX_BACKEND_MODE: 'mcp',
      },
    })).toEqual({
      codexBackendMode: 'appServer',
    });
  });
});

describe('resolveCodexSpawnExtrasForRuntime', () => {
  it('keeps persisted settings ahead of explicit runtime backend mode env overrides', () => {
    expect(
      codexPreferences.resolveCodexSpawnExtrasForRuntime({
        settings: { codexBackendMode: 'acp' },
        processEnv: { HAPPIER_CODEX_BACKEND_MODE: '  mcp_resume  ' },
      }),
    ).toEqual({ codexBackendMode: 'acp' });
  });

  it('does not let retired ACP env residue strip persisted canonical settings', () => {
    expect(
      codexPreferences.resolveCodexSpawnExtrasForRuntime({
        settings: { codexBackendMode: 'acp' },
        processEnv: { HAPPIER_EXPERIMENTAL_CODEX_ACP: '0' },
      }),
    ).toEqual({ codexBackendMode: 'acp' });
  });

  it('falls back to normalized settings when runtime env overrides are absent', () => {
    expect(
      codexPreferences.resolveCodexSpawnExtrasForRuntime({
        settings: { codexBackendMode: 'mcp' },
        processEnv: {},
      }),
    ).toEqual({ codexBackendMode: 'appServer' });
  });

  it('falls back to explicit runtime env overrides only when canonical settings are absent', () => {
    expect(
      codexPreferences.resolveCodexSpawnExtrasForRuntime({
        settings: {},
        processEnv: { HAPPIER_CODEX_BACKEND_MODE: '  mcp_resume  ' },
      }),
    ).toEqual({ codexBackendMode: 'acp' });
  });

  it('ignores the retired ACP env override when no canonical backend mode is present', () => {
    expect(
      codexPreferences.resolveCodexSpawnExtrasForRuntime({
        settings: {},
        processEnv: { HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' },
      }),
    ).toEqual({});
  });
});

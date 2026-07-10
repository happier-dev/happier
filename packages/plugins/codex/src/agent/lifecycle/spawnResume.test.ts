import { describe, expect, it } from 'vitest';

import { resolveCodexVendorResumeSupportParamsForSpawn } from './spawnResume.js';

describe('resolveCodexVendorResumeSupportParamsForSpawn', () => {
  it('returns canonical codex backend mode for codex spawn requests', () => {
    expect(resolveCodexVendorResumeSupportParamsForSpawn({
      catalogAgentId: 'codex',
      options: {
        codexBackendMode: 'acp',
      },
    })).toEqual({ codexBackendMode: 'acp' });
  });

  it('prefers the codex runtime descriptor over the requested backend mode', () => {
    expect(resolveCodexVendorResumeSupportParamsForSpawn({
      catalogAgentId: 'codex',
      options: {
        codexBackendMode: 'acp',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: 'appServer',
          },
        },
      },
    })).toEqual({ codexBackendMode: 'appServer' });
  });

  it('does not inject codex compat params for non-codex providers', () => {
    expect(resolveCodexVendorResumeSupportParamsForSpawn({
      catalogAgentId: 'claude',
      options: {
        codexBackendMode: 'acp',
      },
    })).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';

import { supportsCodexProviderResume } from './support.js';

describe('Codex plugin resume support', () => {
  it('supports final app-server and ACP backend modes', () => {
    expect(supportsCodexProviderResume({
      agentRuntimeSelection: { codexBackendMode: 'appServer' },
    })).toBe(true);
    expect(supportsCodexProviderResume({
      agentRuntimeSelection: { codexBackendMode: 'acp' },
    })).toBe(true);
  });

  it('fails closed when a released legacy MCP input reaches resume support', () => {
    expect(() => supportsCodexProviderResume({
      agentRuntimeSelection: { codexBackendMode: 'mcp' },
    })).toThrow(/codex_legacy_mcp_backend_mode_unsupported/u);
    expect(() => supportsCodexProviderResume({
      agentRuntimeSelection: { codexBackendMode: 'mcp_resume' },
    })).toThrow(/codex_legacy_mcp_backend_mode_unsupported/u);
  });

  it('accepts a canonical runtime descriptor without a Codex-specific host input', () => {
    expect(supportsCodexProviderResume({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread-1',
        },
      },
    })).toBe(true);
  });
});

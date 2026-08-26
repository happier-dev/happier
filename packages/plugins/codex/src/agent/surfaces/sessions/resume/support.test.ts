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

  it('normalizes legacy MCP inputs instead of preserving MCP as a final runtime mode', () => {
    expect(supportsCodexProviderResume({
      agentRuntimeSelection: { codexBackendMode: 'mcp' },
    })).toBe(true);
    expect(supportsCodexProviderResume({
      agentRuntimeSelection: { codexBackendMode: 'mcp_resume' },
    })).toBe(true);
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

import { describe, expect, it } from 'vitest';

import { supportsCodexProviderResume } from './support.js';

describe('Codex plugin resume support', () => {
  it('supports final app-server and ACP backend modes', () => {
    expect(supportsCodexProviderResume({ codexBackendMode: 'appServer' })).toBe(true);
    expect(supportsCodexProviderResume({ codexBackendMode: 'acp' })).toBe(true);
  });

  it('normalizes legacy MCP inputs instead of preserving MCP as a final runtime mode', () => {
    expect(supportsCodexProviderResume({ codexBackendMode: 'mcp' })).toBe(true);
    expect(supportsCodexProviderResume({ codexBackendMode: 'mcp_resume' })).toBe(true);
  });

  it('maps the legacy ACP flag only at compatibility ingress', () => {
    expect(supportsCodexProviderResume({ experimentalCodexAcp: true })).toBe(true);
  });
});

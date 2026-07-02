import { describe, expect, it } from 'vitest';

import { CODEX_BACKEND_MODES, normalizeCodexBackendMode } from './backendMode';

describe('normalizeCodexBackendMode', () => {
  it('publishes only final Codex primary backend modes', () => {
    expect(CODEX_BACKEND_MODES).toEqual(['acp', 'appServer']);
  });

  it('returns null for non-strings and unknown strings', () => {
    expect(normalizeCodexBackendMode(null)).toBeNull();
    expect(normalizeCodexBackendMode(undefined)).toBeNull();
    expect(normalizeCodexBackendMode({})).toBeNull();
    expect(normalizeCodexBackendMode('')).toBeNull();
    expect(normalizeCodexBackendMode('   ')).toBeNull();
    expect(normalizeCodexBackendMode('unknown')).toBeNull();
  });

  it('trims and normalizes supported modes', () => {
    expect(normalizeCodexBackendMode('acp')).toBe('acp');
    expect(normalizeCodexBackendMode('  acp  ')).toBe('acp');
    expect(normalizeCodexBackendMode('appServer')).toBe('appServer');
    expect(normalizeCodexBackendMode('  appServer  ')).toBe('appServer');
  });

  it('maps the retired mcp mode onto app-server for persisted compatibility', () => {
    expect(normalizeCodexBackendMode('mcp')).toBe('appServer');
    expect(normalizeCodexBackendMode('  mcp  ')).toBe('appServer');
  });

  it('maps the legacy mcp_resume mode onto ACP', () => {
    expect(normalizeCodexBackendMode('mcp_resume')).toBe('acp');
    expect(normalizeCodexBackendMode('  mcp_resume  ')).toBe('acp');
  });
});

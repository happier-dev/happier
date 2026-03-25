import { describe, expect, it } from 'vitest';

import { normalizeCodexBackendMode } from './backendMode';

describe('normalizeCodexBackendMode', () => {
  it('returns null for non-strings and unknown strings', () => {
    expect(normalizeCodexBackendMode(null)).toBeNull();
    expect(normalizeCodexBackendMode(undefined)).toBeNull();
    expect(normalizeCodexBackendMode({})).toBeNull();
    expect(normalizeCodexBackendMode('')).toBeNull();
    expect(normalizeCodexBackendMode('   ')).toBeNull();
    expect(normalizeCodexBackendMode('unknown')).toBeNull();
  });

  it('trims and normalizes supported modes', () => {
    expect(normalizeCodexBackendMode('mcp')).toBe('mcp');
    expect(normalizeCodexBackendMode('  mcp  ')).toBe('mcp');
    expect(normalizeCodexBackendMode('acp')).toBe('acp');
    expect(normalizeCodexBackendMode('  acp  ')).toBe('acp');
    expect(normalizeCodexBackendMode('appServer')).toBe('appServer');
    expect(normalizeCodexBackendMode('  appServer  ')).toBe('appServer');
  });

  it('maps the legacy mcp_resume mode onto ACP', () => {
    expect(normalizeCodexBackendMode('mcp_resume')).toBe('acp');
    expect(normalizeCodexBackendMode('  mcp_resume  ')).toBe('acp');
  });
});


import { describe, expect, it } from 'vitest';

import { resolveCodexBackendModeForRun } from './resolveCodexBackendModeForRun';

describe('resolveCodexBackendModeForRun', () => {
  it('prefers explicit canonical backend modes over the legacy ACP flag', () => {
    expect(resolveCodexBackendModeForRun({
      codexBackendMode: 'mcp',
      experimentalCodexAcp: true,
      experimentalCodexAcpEnabledByDefault: true,
    })).toBe('mcp');
    expect(resolveCodexBackendModeForRun({
      codexBackendMode: 'appServer',
      experimentalCodexAcp: true,
      experimentalCodexAcpEnabledByDefault: false,
    })).toBe('appServer');
  });

  it('falls back to the legacy ACP flag only when no canonical backend mode is present', () => {
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcp: true,
      experimentalCodexAcpEnabledByDefault: false,
    })).toBe('acp');
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcp: false,
      experimentalCodexAcpEnabledByDefault: true,
    })).toBe('acp');
  });

  it('uses the default fallback when neither canonical mode nor legacy ACP flag is set', () => {
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcpEnabledByDefault: true,
    })).toBe('acp');
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcpEnabledByDefault: false,
    })).toBe('appServer');
  });
});

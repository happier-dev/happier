import { describe, expect, it } from 'vitest';

import { resolveCodexBackendModeForRun } from './resolveCodexBackendModeForRun';

describe('resolveCodexBackendModeForRun', () => {
  it('falls back to app-server when no canonical backend mode is provided and the ACP default is off', () => {
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcpEnabledByDefault: false,
    })).toBe('appServer');
  });

  it('honors explicit codexBackendMode=acp when the env-backed experiment flag is off', () => {
    expect(resolveCodexBackendModeForRun({
      codexBackendMode: 'acp',
      experimentalCodexAcpEnabledByDefault: false,
    })).toBe('acp');
  });

  it('prefers explicit canonical backend modes over the default ACP toggle', () => {
    expect(resolveCodexBackendModeForRun({
      codexBackendMode: 'mcp',
      experimentalCodexAcpEnabledByDefault: true,
    })).toBe('mcp');
    expect(resolveCodexBackendModeForRun({
      codexBackendMode: 'appServer',
      experimentalCodexAcpEnabledByDefault: false,
    })).toBe('appServer');
  });

  it('falls back to the default only when no explicit canonical mode is present', () => {
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcpEnabledByDefault: true,
    })).toBe('acp');
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcpEnabledByDefault: true,
    })).toBe('acp');
    expect(resolveCodexBackendModeForRun({
      experimentalCodexAcpEnabledByDefault: false,
    })).toBe('appServer');
  });
});

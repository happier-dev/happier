import { describe, expect, it } from 'vitest';

import {
  resolveCanonicalCodexBackendMode,
  resolveCanonicalCodexBackendModeFromCompatInput,
  resolveCodexBackendModeForRun,
  resolveCodexSessionBackendMode,
} from './backendMode.js';

describe('resolveCanonicalCodexBackendMode', () => {
  it('normalizes legacy Codex backend aliases from explicit requests', () => {
    expect(resolveCanonicalCodexBackendMode({
      codexBackendMode: '  mcp_resume  ',
    })).toBe('acp');
  });

  it('normalizes neutral backend mode requests', () => {
    expect(resolveCanonicalCodexBackendMode({
      backendMode: '  mcp_resume  ',
    })).toBe('acp');
  });

  it('fails closed for the released legacy MCP spelling instead of reinterpreting it as App Server', () => {
    expect(() => resolveCanonicalCodexBackendMode({
      codexBackendMode: 'mcp',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
        },
      },
    })).toThrow(expect.objectContaining({
      code: 'codex_legacy_mcp_backend_mode_unsupported',
    }));
    expect(() => resolveCanonicalCodexBackendMode({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'mcp' },
      },
    })).toThrow(expect.objectContaining({
      code: 'codex_legacy_mcp_backend_mode_unsupported',
    }));
  });
});

describe('resolveCanonicalCodexBackendModeFromCompatInput', () => {
  it('maps the legacy ACP compatibility flag onto canonical acp only at the transport ingress', () => {
    expect(resolveCanonicalCodexBackendModeFromCompatInput({
      experimentalCodexAcp: true,
    })).toBe('acp');
  });

  it('prefers the canonical runtime descriptor over the legacy ACP compatibility flag at compat ingress', () => {
    expect(resolveCanonicalCodexBackendModeFromCompatInput({
      experimentalCodexAcp: true,
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
        },
      },
    })).toBe('appServer');
  });
});

describe('resolveCodexBackendModeForRun', () => {
  it('falls back to app-server when no canonical backend mode is provided', () => {
    expect(resolveCodexBackendModeForRun({})).toBe('appServer');
  });

  it('honors explicit canonical backend modes ahead of defaults', () => {
    expect(resolveCodexBackendModeForRun({
      codexBackendMode: 'acp',
      defaultBackendMode: 'appServer',
    })).toBe('acp');
    expect(resolveCodexBackendModeForRun({
      codexBackendMode: 'appServer',
      defaultBackendMode: 'acp',
    })).toBe('appServer');
  });

  it('falls back to the default only when no explicit canonical mode is present', () => {
    expect(resolveCodexBackendModeForRun({
      defaultBackendMode: 'acp',
    })).toBe('acp');
  });

  it('does not let the run-settings ingress reinterpret legacy MCP as App Server', () => {
    expect(() => resolveCodexBackendModeForRun({
      codexBackendMode: 'mcp',
    })).toThrow(expect.objectContaining({
      code: 'codex_legacy_mcp_backend_mode_unsupported',
    }));
    expect(() => resolveCodexBackendModeForRun({
      defaultBackendMode: 'mcp',
    })).toThrow(expect.objectContaining({
      code: 'codex_legacy_mcp_backend_mode_unsupported',
    }));
  });
});

describe('resolveCodexSessionBackendMode', () => {
  it('defaults configured Codex sessions to app-server', () => {
    expect(resolveCodexSessionBackendMode({
      accountSettings: null,
    })).toBe('appServer');
  });

  it('uses the typed configured runtime mode supplied by the host', () => {
    expect(resolveCodexSessionBackendMode({
      accountSettings: { codexBackendMode: 'acp' },
    })).toBe('acp');
  });
});

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

  it('prefers the canonical runtime descriptor over explicit backend mode input', () => {
    expect(resolveCanonicalCodexBackendMode({
      codexBackendMode: 'mcp',
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
});

describe('resolveCodexSessionBackendMode', () => {
  it('defaults configured Codex sessions to app-server', () => {
    expect(resolveCodexSessionBackendMode({
      metadata: null,
      accountSettings: null,
    })).toBe('appServer');
  });

  it('prefers persisted canonical Codex runtime identity over account settings', () => {
    expect(resolveCodexSessionBackendMode({
      metadata: {
        codexBackendMode: 'acp',
      },
      accountSettings: { codexBackendMode: 'appServer' },
    })).toBe('acp');
  });

  it('does not treat persisted legacy mcp runtime identity as app-server control support', () => {
    expect(resolveCodexSessionBackendMode({
      metadata: {
        codexBackendMode: 'mcp',
      },
      accountSettings: { codexBackendMode: 'appServer' },
    })).toBeNull();
  });
});

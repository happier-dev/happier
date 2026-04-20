import { describe, expect, it } from 'vitest';

import {
  resolveCanonicalCodexBackendMode,
  resolveCanonicalCodexBackendModeFromCompatInput,
} from './backendMode.js';

describe('resolveCanonicalCodexBackendMode', () => {
  it('normalizes legacy Codex backend aliases from explicit requests', () => {
    expect(resolveCanonicalCodexBackendMode({
      codexBackendMode: '  mcp_resume  ',
    })).toBe('acp');
  });

  it('prefers the canonical runtime descriptor over explicit backend mode input', () => {
    expect(resolveCanonicalCodexBackendMode({
      codexBackendMode: 'mcp',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
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
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
        },
      },
    })).toBe('appServer');
  });
});

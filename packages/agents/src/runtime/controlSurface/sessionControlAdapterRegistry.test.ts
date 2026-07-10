import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS,
  getProviderSessionControlAdapter,
} from './sessionControlAdapterRegistry.js';

describe('sessionControlAdapterRegistry', () => {
  it('loads provider session-control rows through generated contributions instead of manual provider imports', () => {
    const source = readFileSync(new URL('./sessionControlAdapterRegistry.ts', import.meta.url), 'utf8');
    const generatedSource = readFileSync(new URL('../../generated/sessionControlAdapters.ts', import.meta.url), 'utf8');

    expect(source).toContain('../../generated/sessionControlAdapters.js');
    expect(source).not.toContain('../../providers/codex/sessionControlAdapter.js');
    expect(source).not.toContain('./opencode.js');
    expect(source).not.toContain('../../providers/pi/sessionControlAdapter.js');
    expect(source).not.toContain('CODEX_SESSION_CONTROL_ADAPTER');
    expect(source).not.toContain('OPENCODE_SESSION_CONTROL_ADAPTER');
    expect(source).not.toContain('PI_SESSION_CONTROL_ADAPTER');
    expect(generatedSource).not.toContain('@happier-dev/plugins-');
    expect(generatedSource).not.toContain('../providers/codex/sessionControlAdapter.js');
    expect(generatedSource).not.toContain('../providers/opencode/sessionControlAdapter.js');
    expect(generatedSource).toContain('createGeneratedRuntimeProjectionSessionControlAdapter');
  });

  it('exposes only the providers that own session-control adapters', () => {
    expect(PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
  });

  it('routes each supported provider id to its generated adapter and nothing else', () => {
    expect(getProviderSessionControlAdapter('codex')?.normalizeRuntimeKindOverride?.(' appServer ')).toBe('appServer');
    expect(getProviderSessionControlAdapter('codex')?.normalizeRuntimeKindOverride?.(' mcp ')).toBe('appServer');
    expect(getProviderSessionControlAdapter('codex')?.resolvePersistedSessionRuntimeKind?.({
      codexBackendMode: 'mcp',
      codexSessionId: 'thread-mcp',
    })).toBe('mcp');
    expect(getProviderSessionControlAdapter('codex')?.resolveConfiguredRuntimeKind?.({
      experimentalCodexAcp: true,
    })).toBe('appServer');
    expect(getProviderSessionControlAdapter('opencode')?.normalizeRuntimeKindOverride?.(' acp ')).toBe('acp');
    expect(getProviderSessionControlAdapter('opencode')?.normalizeRuntimeKindOverride?.('server')).toBe('server');
    expect(getProviderSessionControlAdapter('opencode')?.normalizeRuntimeKindOverride?.('appServer')).toBeNull();
    expect(getProviderSessionControlAdapter('opencode')?.resolveConfiguredRuntimeKind?.({ opencodeBackendMode: ' acp ' })).toBe('acp');
    expect(getProviderSessionControlAdapter('opencode')?.applyRuntimeKindOverrideToAccountSettings?.({ other: 'value' }, 'server')).toEqual({
      other: 'value',
      opencodeBackendMode: 'server',
    });
    expect(getProviderSessionControlAdapter('opencode')?.resolveVendorResumeId?.({
      opencodeBackendMode: 'server',
      opencodeSessionId: ' opencode-session-1 ',
    })).toBe('opencode-session-1');
    expect(getProviderSessionControlAdapter('pi')?.resolveVendorResumeId?.({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileAbsolutePreferred',
          providerSessionId: 'pi-session-1',
          sessionFile: '/tmp/pi-session-1.jsonl',
        },
      },
    })).toBe('/tmp/pi-session-1.jsonl');
    expect(getProviderSessionControlAdapter('claude')).toBeNull();
    expect(getProviderSessionControlAdapter('customAcp')).toBeNull();
  });
});

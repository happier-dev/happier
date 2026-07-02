import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  getRuntimeDescriptorReader,
  getProviderRuntimeDescriptorReader,
} from './runtimeDescriptorReaderRegistry.js';

describe('runtimeDescriptorReaderRegistry', () => {
  it('loads provider runtime descriptor readers through generated contributions instead of manual provider imports', () => {
    const source = readFileSync(new URL('../runtime/identity/runtimeDescriptorReaderRegistry.ts', import.meta.url), 'utf8');
    const generatedSource = readFileSync(new URL('../generated/runtimeDescriptorReaders.ts', import.meta.url), 'utf8');

    expect(source).toContain('../../generated/runtimeDescriptorReaders.js');
    expect(source).not.toContain('../../providers/codex/readSessionMetadataRuntimeDescriptor.js');
    expect(source).not.toContain('../runtime/identity/opencode/readMetadata.js');
    expect(source).not.toContain('../../providers/pi/readSessionMetadataRuntimeDescriptor.js');
    expect(source).not.toContain('readCodexSessionMetadataRuntimeDescriptor');
    expect(source).not.toContain('readOpenCodeSessionMetadataRuntimeDescriptor');
    expect(source).not.toContain('readPiSessionMetadataRuntimeDescriptor');
    expect(generatedSource).not.toContain('@happier-dev/plugins-');
    expect(generatedSource).toContain('../providers/codex/readSessionMetadataRuntimeDescriptor.js');
    expect(generatedSource).toContain('../providers/opencode/readSessionMetadataRuntimeDescriptor.js');
  });

  it('keeps generated plugin reader leaves independent from agents and protocol package roots', () => {
    const pluginLeafSources = [
      '../../../../packages/plugins/codex/src/agent/identity/runtimeDescriptor.ts',
      '../../../../packages/plugins/opencode/src/agent/identity/runtimeDescriptor.ts',
      '../../../../packages/plugins/codex/src/agent/surfaces/sessions/controls/adapter.ts',
      '../../../../packages/plugins/opencode/src/agent/surfaces/sessions/controls/adapter.ts',
    ];

    for (const sourcePath of pluginLeafSources) {
      const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
      expect(source).not.toContain("from '@happier-dev/agents'");
      expect(source).not.toContain('from "@happier-dev/agents"');
      expect(source).not.toContain("from '@happier-dev/protocol'");
      expect(source).not.toContain('from "@happier-dev/protocol"');
    }
  });

  it('exposes only the providers that own runtime descriptor readers', () => {
    expect(RUNTIME_DESCRIPTOR_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
    expect(PROVIDER_RUNTIME_DESCRIPTOR_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
  });

  it('routes each supported provider id to its generated reader', () => {
    expect(getRuntimeDescriptorReader('codex')?.({
      codexBackendMode: 'appServer',
      codexSessionId: ' thread-1 ',
    })).toMatchObject({
      providerId: 'codex',
      runtimeKind: 'appServer',
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
    });
    expect(getRuntimeDescriptorReader('opencode')?.({
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: ' http://127.0.0.1:4096 ',
      opencodeServerBaseUrlExplicit: true,
      opencodeSessionId: ' opencode-session-1 ',
    })).toEqual({
      providerId: 'opencode',
      runtimeKind: 'server',
      backendMode: 'server',
      providerSessionId: 'opencode-session-1',
      runtimeHandle: {
        backendMode: 'server',
        providerSessionId: 'opencode-session-1',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      },
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
    expect(getProviderRuntimeDescriptorReader('codex')).toBe(getRuntimeDescriptorReader('codex'));
    expect(getProviderRuntimeDescriptorReader('opencode')).toBe(getRuntimeDescriptorReader('opencode'));
    expect(getRuntimeDescriptorReader('pi')?.({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileBySessionId',
          providerSessionId: 'pi-session-1',
        },
      },
    })).toEqual({
      providerId: 'pi',
      runtimeKind: null,
      providerSessionId: 'pi-session-1',
      runtimeHandle: {
        providerSessionId: 'pi-session-1',
      },
    });
  });

  it('fails closed for non-record metadata and uncontributed providers', () => {
    expect(getRuntimeDescriptorReader('pi')?.(null as unknown as Record<string, unknown>)).toBeNull();
    expect(getRuntimeDescriptorReader('claude')).toBeNull();
    expect(getRuntimeDescriptorReader('customAcp')).toBeNull();
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  getRuntimeDescriptorReader,
} from './runtimeDescriptorReaderRegistry.js';
import { readSessionMetadataConnectedServiceBindings } from './readSessionMetadataRuntimeDescriptor.js';

describe('runtimeDescriptorReaderRegistry', () => {
  it('loads provider runtime descriptor readers through generated contributions instead of manual provider imports', () => {
    const source = readFileSync(new URL('./runtimeDescriptorReaderRegistry.ts', import.meta.url), 'utf8');
    const generatedSource = readFileSync(new URL('../../generated/runtimeDescriptorReaders.ts', import.meta.url), 'utf8');
    const metadataReaderSource = readFileSync(new URL('./readSessionMetadataRuntimeDescriptor.ts', import.meta.url), 'utf8');

    expect(source).toContain('../../generated/runtimeDescriptorReaders.js');
    expect(source).not.toContain('../../providers/codex/readSessionMetadataRuntimeDescriptor.js');
    expect(source).not.toContain('../runtime/identity/opencode/readMetadata.js');
    expect(source).not.toContain('../../providers/pi/readSessionMetadataRuntimeDescriptor.js');
    expect(source).not.toContain('readCodexSessionMetadataRuntimeDescriptor');
    expect(source).not.toContain('readOpenCodeSessionMetadataRuntimeDescriptor');
    expect(source).not.toContain('readPiSessionMetadataRuntimeDescriptor');
    expect(generatedSource).not.toContain('@happier-dev/plugins-');
    expect(generatedSource).not.toContain('../providers/codex/readSessionMetadataRuntimeDescriptor.js');
    expect(generatedSource).not.toContain('../providers/opencode/readSessionMetadataRuntimeDescriptor.js');
    expect(generatedSource).toContain('createGeneratedRuntimeDescriptorReader');
    expect(metadataReaderSource).not.toContain('./codex/readSessionMetadataRuntimeDescriptor.js');
    expect(metadataReaderSource).not.toContain("providerId === 'codex'");
    expect(metadataReaderSource).not.toContain('readCodexSessionMetadataConnectedServiceBindings');
  });

  it('keeps generated plugin reader leaves independent from agents and protocol package roots', () => {
    const pluginLeafSources = [
      '../../../../plugins/codex/src/agent/identity/runtimeDescriptor.ts',
      '../../../../plugins/opencode/src/agent/identity/runtimeDescriptor.ts',
      '../../../../plugins/codex/src/agent/surfaces/sessions/controls/adapter.ts',
      '../../../../plugins/opencode/src/agent/surfaces/sessions/controls/adapter.ts',
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
  });

  it('routes each supported provider id to its generated reader', () => {
    expect(getRuntimeDescriptorReader('codex')?.({
      codexBackendMode: 'appServer',
      codexSessionId: ' thread-1 ',
    })).toMatchObject({
      agentId: 'codex',
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
      agentId: 'opencode',
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
    expect(getRuntimeDescriptorReader('pi')?.({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileBySessionId',
          providerSessionId: 'pi-session-1',
        },
      },
    })).toEqual({
      agentId: 'pi',
      runtimeKind: null,
      providerSessionId: 'pi-session-1',
      runtimeHandle: {
        providerSessionId: 'pi-session-1',
      },
    });
  });

  it('derives connected-service bindings from generated runtime descriptors', () => {
    expect(readSessionMetadataConnectedServiceBindings({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread-1',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceGroupId: 'team',
          connectedServiceProfileId: 'work',
        },
      },
    }, 'codex')).toEqual({
      'openai-codex': {
        source: 'connected',
        selection: 'group',
        groupId: 'team',
        profileId: 'work',
      },
    });
  });

  it('preserves OpenCode legacy URL validation in the generated reader', () => {
    expect(getRuntimeDescriptorReader('opencode')?.({
      opencodeServerBaseUrl: 'http://example.com:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toBeNull();

    expect(getRuntimeDescriptorReader('opencode')?.({
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'ftp://127.0.0.1:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toEqual({
      agentId: 'opencode',
      runtimeKind: 'acp',
      backendMode: 'acp',
      providerSessionId: null,
      runtimeHandle: {
        backendMode: 'acp',
      },
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    });
  });

  it('fails closed for non-record metadata and uncontributed providers', () => {
    expect(getRuntimeDescriptorReader('pi')?.(null as unknown as Record<string, unknown>)).toBeNull();
    expect(getRuntimeDescriptorReader('claude')).toBeNull();
    expect(getRuntimeDescriptorReader('customAcp')).toBeNull();
  });
});

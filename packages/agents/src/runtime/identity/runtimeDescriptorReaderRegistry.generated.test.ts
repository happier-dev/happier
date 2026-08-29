import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  getRuntimeDescriptorReader,
} from './runtimeDescriptorReaderRegistry.js';
import {
  readSessionMetadataConnectedServiceBindings,
  readSessionMetadataRuntimeDescriptor,
} from './readSessionMetadataRuntimeDescriptor.js';

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

  it('keeps generated plugin reader leaves free of circular agents imports and declares protocol imports', () => {
    const pluginLeaves = [
      { packageId: 'opencode', sourcePath: '../../../../plugins/opencode/src/agent/identity/runtimeDescriptor.ts' },
    ] as const;

    for (const { packageId, sourcePath } of pluginLeaves) {
      const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
      expect(source).not.toContain("from '@happier-dev/agents'");
      expect(source).not.toContain('from "@happier-dev/agents"');
      if (
        source.includes("from '@happier-dev/protocol'")
        || source.includes('from "@happier-dev/protocol"')
      ) {
        const packageJson = JSON.parse(readFileSync(
          new URL(`../../../../plugins/${packageId}/package.json`, import.meta.url),
          'utf8',
        )) as { dependencies?: Record<string, string> };
        expect(packageJson.dependencies?.['@happier-dev/protocol']).toBe('0.0.0');
      }
    }
  });

  it('exposes only the providers that own runtime descriptor readers', () => {
    expect(RUNTIME_DESCRIPTOR_PROVIDER_IDS).toEqual(['codex', 'opencode']);
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
  });

  it('derives connected-service bindings only from released flat metadata', () => {
    expect(readSessionMetadataConnectedServiceBindings({
      codexBackendMode: 'appServer',
      codexSessionId: 'thread-1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'team',
      connectedServiceProfileId: 'work',
    }, 'codex')).toEqual({
      'openai-codex': {
        source: 'connected',
        selection: 'group',
        groupId: 'team',
        profileId: 'work',
      },
    });
  });

  it('reads the retired persisted descriptor envelope at the same compatibility owner', () => {
    expect(readSessionMetadataConnectedServiceBindings({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
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

    expect(readSessionMetadataConnectedServiceBindings({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
        },
      },
    }, 'opencode')).toEqual({});
  });

  it('keeps current Agent descriptors opaque while reading released flat compatibility', () => {
    const reader = getRuntimeDescriptorReader('codex');
    const expected = {
      agentId: 'codex',
      runtimeKind: 'appServer',
      backendMode: 'appServer',
      providerSessionId: 'thread-legacy',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'legacy-profile',
    };
    const current = reader?.({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread-legacy',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'legacy-profile',
        },
      },
    });
    const legacy = reader?.({
      codexBackendMode: 'appServer',
      codexSessionId: 'thread-legacy',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'legacy-profile',
    });

    expect(current).toBeNull();
    expect(legacy).toMatchObject(expected);
    expect(readSessionMetadataRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'future-codex-mode',
          providerSessionId: 'thread-current',
          externallyAuthoredField: 'preserve-me',
        },
      },
    }, 'codex')).toBeNull();
    expect(readSessionMetadataConnectedServiceBindings({
      codexBackendMode: 'appServer',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'legacy-profile',
    }, 'codex')).toEqual({
      'openai-codex': {
        source: 'connected',
        selection: 'profile',
        profileId: 'legacy-profile',
      },
    });
    expect(readSessionMetadataConnectedServiceBindings({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'current-profile',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'retired-profile',
        },
      },
    }, 'codex')).toEqual({});
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
    expect(getRuntimeDescriptorReader('codex')?.(null as unknown as Record<string, unknown>)).toBeNull();
    expect(getRuntimeDescriptorReader('antigravity')).toBeNull();
    expect(getRuntimeDescriptorReader('pi')).toBeNull();
    expect(getRuntimeDescriptorReader('claude')).toBeNull();
    expect(getRuntimeDescriptorReader('customAcp')).toBeNull();
  });
});

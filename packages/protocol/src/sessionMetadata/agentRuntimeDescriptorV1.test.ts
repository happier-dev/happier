import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeDescriptorV1Schema,
  buildCodexAgentRuntimeDescriptorV1,
  buildOpenCodeAgentRuntimeDescriptorV1,
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
  readAgentRuntimeDescriptorV1ForProvider,
} from './agentRuntimeDescriptorV1';

describe('agentRuntimeDescriptorV1', () => {
  it('parses generic provider envelopes with provider-owned extras', () => {
    expect(AgentRuntimeDescriptorV1Schema.parse({
      v: 1,
      providerId: 'custom-provider',
      provider: {
        backendMode: 'custom-runtime',
        vendorSessionId: 'session_1',
        providerExtra: {
          owner: 'apps/cli',
          schemaId: 'custom-provider.runtimeDescriptor.extra',
          v: 1,
          customFlag: true,
        },
      },
      extra: 'x',
    })).toMatchObject({
      providerId: 'custom-provider',
      provider: {
        backendMode: 'custom-runtime',
        vendorSessionId: 'session_1',
        providerExtra: {
          owner: 'apps/cli',
          schemaId: 'custom-provider.runtimeDescriptor.extra',
          v: 1,
          customFlag: true,
        },
      },
      extra: 'x',
    });
  });

  it('builds and parses a codex descriptor', () => {
    const built = buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
      vendorSessionId: 'thread_1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/codex-home',
    });
    expect(AgentRuntimeDescriptorV1Schema.parse({ ...built, extra: 'x' })).toMatchObject({
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_1',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/codex-home',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeAffinity: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_1',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/codex-home',
          },
        },
      },
      extra: 'x',
    });
  });

  it('builds and parses codex source affinity fields', () => {
    const built = buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
      vendorSessionId: 'thread_connected',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
    });

    expect(AgentRuntimeDescriptorV1Schema.parse(built)).toMatchObject({
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_connected',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeAffinity: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_connected',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
          },
        },
      },
    });
  });

  it('reads provider-specific descriptors safely', () => {
    const built = buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      vendorSessionId: 'op_sess_1',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
    expect(readAgentRuntimeDescriptorV1ForProvider(built, 'opencode')).toMatchObject({
      provider: {
        backendMode: 'server',
        vendorSessionId: 'op_sess_1',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
        providerExtra: {
          owner: 'opencode',
          schemaId: 'opencode.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            backendMode: 'server',
            vendorSessionId: 'op_sess_1',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
          },
        },
      },
    });
    expect(readAgentRuntimeDescriptorV1ForProvider(built, 'codex')).toBeNull();
  });

  it('prefers providerExtra runtime affinity over stale provider fields', () => {
    expect(readCanonicalAgentRuntimeDescriptorV1ForProvider({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'mcp',
        vendorSessionId: 'thread_legacy',
        home: 'user',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeAffinity: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
          },
        },
      },
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'appServer',
      vendorSessionId: 'thread_runtime',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: null,
      homePath: null,
    });

    expect(readCanonicalAgentRuntimeDescriptorV1ForProvider({
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'acp',
        vendorSessionId: 'sess_legacy',
        serverBaseUrl: 'http://legacy.example',
        providerExtra: {
          owner: 'opencode',
          schemaId: 'opencode.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            backendMode: 'server',
            vendorSessionId: 'sess_runtime',
            serverBaseUrl: 'http://canonical.example',
            serverBaseUrlExplicit: true,
          },
        },
      },
    }, 'opencode')).toEqual({
      providerId: 'opencode',
      backendMode: 'server',
      vendorSessionId: 'sess_runtime',
      serverBaseUrl: 'http://canonical.example',
      serverBaseUrlExplicit: true,
    });
  });
});

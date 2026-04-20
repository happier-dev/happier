import { describe, expect, it } from 'vitest';

import {
  buildCodexAgentRuntimeDescriptor,
  buildOpenCodeAgentRuntimeDescriptor,
  readNormalizedRuntimeDescriptor,
  readSessionMetadataRuntimeDescriptor,
} from './agentRuntimeDescriptor.js';

describe('readSessionMetadataRuntimeDescriptor', () => {
  it('prefers canonical runtimeDescriptorV1 over the legacy agentRuntimeDescriptorV1 carrier', () => {
    expect(readSessionMetadataRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'canonical-thread',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          vendorSessionId: 'legacy-thread',
        },
      },
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'appServer',
      vendorSessionId: 'canonical-thread',
      home: null,
      connectedServiceId: null,
      connectedServiceProfileId: null,
      homePath: null,
    });
  });

  it('builds a canonical codex runtime descriptor with provider-owned runtime affinity', () => {
    const descriptor = buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      vendorSessionId: 'thread_connected',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/codex-home',
    });

    expect(readSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: descriptor,
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'appServer',
      vendorSessionId: 'thread_connected',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/codex-home',
    });
  });

  it('builds a canonical OpenCode runtime descriptor with provider-owned runtime handle', () => {
    const descriptor = buildOpenCodeAgentRuntimeDescriptor({
      backendMode: 'server',
      vendorSessionId: 'oc_runtime',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });

    expect(readSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: descriptor,
    }, 'opencode')).toEqual({
      providerId: 'opencode',
      backendMode: 'server',
      vendorSessionId: 'oc_runtime',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
  });

  it('returns codex source affinity from the generic runtime descriptor', () => {
    expect(readSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'thread_connected',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'appServer',
      vendorSessionId: 'thread_connected',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: null,
      homePath: null,
    });
  });

  it('prefers codex providerExtra over legacy provider fields', () => {
    expect(readSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'provider-thread',
          home: 'user',
          connectedServiceId: 'provider-service',
          providerExtra: {
            v: 1,
            runtimeAffinity: {
              backendMode: 'acp',
              vendorSessionId: 'extra-thread',
              home: 'connectedService',
              connectedServiceId: 'extra-service',
              connectedServiceProfileId: 'work',
              homePath: '/tmp/codex-home',
            },
          },
        },
      },
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'acp',
      vendorSessionId: 'extra-thread',
      home: 'connectedService',
      connectedServiceId: 'extra-service',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/codex-home',
    });
  });

  it('normalizes legacy codex backend aliases from generic runtime descriptors', () => {
    expect(readSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: '  mcp_resume  ',
          vendorSessionId: 'thread_legacy',
        },
      },
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'acp',
      vendorSessionId: 'thread_legacy',
      home: null,
      connectedServiceId: null,
      connectedServiceProfileId: null,
      homePath: null,
    });
  });

  it('does not retain stale connected-service fields when the canonical codex home resolves to user', () => {
    expect(readSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'thread_connected',
          home: 'user',
          connectedServiceId: 'stale-service',
          connectedServiceProfileId: 'stale-profile',
          homePath: '/tmp/codex-home',
        },
      },
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'appServer',
      vendorSessionId: 'thread_connected',
      home: 'user',
      connectedServiceId: null,
      connectedServiceProfileId: null,
      homePath: '/tmp/codex-home',
    });
  });

  it('prefers OpenCode providerExtra runtime handle fields over legacy provider fields', () => {
    expect(readSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'acp',
          vendorSessionId: 'legacy_oc',
          serverBaseUrl: 'http://127.0.0.1:4999/',
          serverBaseUrlExplicit: false,
          providerExtra: {
            v: 1,
            runtimeHandle: {
              backendMode: 'server',
              vendorSessionId: 'oc_1',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            },
          },
        },
      },
    }, 'opencode')).toEqual({
      providerId: 'opencode',
      backendMode: 'server',
      vendorSessionId: 'oc_1',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
  });

  it('normalizes plugin-shaped runtime descriptors without built-in provider id assumptions', () => {
    expect(readNormalizedRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'acmePlugin',
        provider: {
          backendMode: 'daemon',
          vendorSessionId: 'plugin-session-1',
          providerExtra: {
            owner: 'acme',
            schemaId: 'acme.runtimeDescriptor',
            v: 1,
            runtimeHandle: {
              endpoint: 'ws://127.0.0.1:7777',
            },
          },
        },
      },
    })).toEqual({
      providerId: 'acmePlugin',
      runtimeKind: 'daemon',
      vendorSessionId: 'plugin-session-1',
      runtimeHandle: {
        endpoint: 'ws://127.0.0.1:7777',
      },
      rawProvider: {
        backendMode: 'daemon',
        vendorSessionId: 'plugin-session-1',
        providerExtra: {
          owner: 'acme',
          schemaId: 'acme.runtimeDescriptor',
          v: 1,
          runtimeHandle: {
            endpoint: 'ws://127.0.0.1:7777',
          },
        },
      },
    });
  });

  it('does not treat legacy runtimeAffinity carriers as canonical runtime handles for unknown providers', () => {
    expect(readNormalizedRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'acmePlugin',
        provider: {
          backendMode: 'daemon',
          vendorSessionId: 'plugin-session-1',
          providerExtra: {
            owner: 'acme',
            schemaId: 'acme.runtimeDescriptor',
            v: 1,
            runtimeAffinity: {
              endpoint: 'ws://127.0.0.1:7777',
            },
          },
        },
      },
    })).toEqual({
      providerId: 'acmePlugin',
      runtimeKind: 'daemon',
      vendorSessionId: 'plugin-session-1',
      runtimeHandle: null,
      rawProvider: {
        backendMode: 'daemon',
        vendorSessionId: 'plugin-session-1',
        providerExtra: {
          owner: 'acme',
          schemaId: 'acme.runtimeDescriptor',
          v: 1,
          runtimeAffinity: {
            endpoint: 'ws://127.0.0.1:7777',
          },
        },
      },
    });
  });

  it('normalizes supported codex runtime affinity carriers into canonical runtime handles', () => {
    expect(readNormalizedRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'mcp',
          vendorSessionId: 'legacy-thread',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeHandle: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-runtime',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
              connectedServiceProfileId: 'work',
              homePath: '/tmp/codex-home',
            },
          },
        },
      },
    })).toEqual({
      providerId: 'codex',
      runtimeKind: 'appServer',
      vendorSessionId: 'thread-runtime',
      runtimeHandle: {
        backendMode: 'appServer',
        vendorSessionId: 'thread-runtime',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/codex-home',
      },
      rawProvider: {
        backendMode: 'mcp',
        vendorSessionId: 'legacy-thread',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            backendMode: 'appServer',
            vendorSessionId: 'thread-runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/codex-home',
          },
        },
      },
    });

    expect(readNormalizedRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'mcp',
          vendorSessionId: 'legacy-thread',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-runtime',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
              connectedServiceProfileId: 'work',
              homePath: '/tmp/codex-home',
            },
          },
        },
      },
    })).toEqual({
      providerId: 'codex',
      runtimeKind: 'appServer',
      vendorSessionId: 'thread-runtime',
      runtimeHandle: {
        backendMode: 'appServer',
        vendorSessionId: 'thread-runtime',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/codex-home',
      },
      rawProvider: {
        backendMode: 'mcp',
        vendorSessionId: 'legacy-thread',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeAffinity: {
            backendMode: 'appServer',
            vendorSessionId: 'thread-runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/codex-home',
          },
        },
      },
    });
  });

  it('returns null when runtime descriptor metadata is absent', () => {
    expect(readNormalizedRuntimeDescriptor({
      unrelated: 'value',
    })).toBeNull();
  });
});

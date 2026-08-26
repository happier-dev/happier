import { describe, expect, it } from 'vitest';

import { readOpenCodeSessionMetadataRuntimeDescriptor } from './runtimeDescriptor.js';

describe('OpenCode runtime descriptor metadata reader', () => {
  it('reads the bounded agent-surface runtime descriptor before legacy metadata', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: ' opencode-surface-1 ',
          serverBaseUrl: 'http://127.0.0.1:49196/path?ignored=true',
          serverBaseUrlExplicit: true,
        },
      },
      opencodeBackendMode: 'acp',
      opencodeSessionId: 'legacy-session',
    })).toMatchObject({
      agentId: 'opencode',
      runtimeKind: 'server',
      backendMode: 'server',
      providerSessionId: 'opencode-surface-1',
      serverBaseUrl: 'http://127.0.0.1:49196/',
      serverBaseUrlExplicit: true,
    });
  });

  it('reads legacy-only OpenCode metadata as a canonical runtime descriptor', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeBackendMode: ' acp ',
      opencodeSessionId: ' opencode-session-legacy ',
      opencodeServerBaseUrl: 'http://127.0.0.1:49196',
      opencodeServerBaseUrlExplicit: true,
    })).toEqual({
      agentId: 'opencode',
      runtimeKind: 'acp',
      backendMode: 'acp',
      providerSessionId: 'opencode-session-legacy',
      runtimeHandle: {
        backendMode: 'acp',
        providerSessionId: 'opencode-session-legacy',
        serverBaseUrl: 'http://127.0.0.1:49196/',
        serverBaseUrlExplicit: true,
      },
      serverBaseUrl: 'http://127.0.0.1:49196/',
      serverBaseUrlExplicit: true,
    });
  });

  it('reads HTTPS hosts but rejects non-loopback HTTP metadata', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeServerBaseUrl: 'https://OpenCode.Example.test:443/path?ignored=true#hash',
      opencodeServerBaseUrlExplicit: true,
    })).toMatchObject({
      serverBaseUrl: 'https://opencode.example.test/',
      serverBaseUrlExplicit: true,
    });

    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeServerBaseUrl: 'http://192.168.1.50:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toBeNull();
  });

  it('fails closed for invalid explicit legacy server URLs', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeServerBaseUrl: 'http://opencode:secret@example.com:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toBeNull();

    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'ftp://127.0.0.1:49196',
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

  it('does not bypass the host runtime-descriptor validator for malformed persisted identities', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      runtimeDescriptorV1: {
        v: 1,
        agentIdentity: { pluginId: 'not a valid plugin id', localId: 'opencode' },
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'must-not-leak-through',
        },
      },
    })).toBeNull();
  });
});

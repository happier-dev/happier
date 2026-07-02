import { describe, expect, it } from 'vitest';

import {
  readOpenCodeSessionAffinityFromMetadata,
  readOpenCodeSessionMetadataRuntimeDescriptor,
} from './readSessionMetadataRuntimeDescriptor.js';

describe('OpenCode runtime descriptor metadata reader', () => {
  it('reads legacy-only OpenCode metadata as a canonical runtime descriptor', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeBackendMode: ' acp ',
      opencodeSessionId: ' opencode-session-legacy ',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toEqual({
      providerId: 'opencode',
      runtimeKind: 'acp',
      backendMode: 'acp',
      providerSessionId: 'opencode-session-legacy',
      runtimeHandle: {
        backendMode: 'acp',
        providerSessionId: 'opencode-session-legacy',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      },
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
  });

  it('fails closed for invalid explicit legacy server URLs', () => {
    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeServerBaseUrl: 'http://example.com:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toBeNull();

    expect(readOpenCodeSessionMetadataRuntimeDescriptor({
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'ftp://127.0.0.1:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toEqual({
      providerId: 'opencode',
      runtimeKind: 'acp',
      backendMode: 'acp',
      providerSessionId: null,
      runtimeHandle: {
        backendMode: 'acp',
      },
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    });

    expect(readOpenCodeSessionAffinityFromMetadata({
      opencodeServerBaseUrl: 'https://user:secret@example.com',
      opencodeServerBaseUrlExplicit: true,
    })).toEqual({
      backendMode: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    });
  });
});

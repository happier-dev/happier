import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
} from './runtimeDescriptorV1.js';

describe('OpenCode runtime descriptor v1', () => {
  it('owns the provider codec inside the plugin leaf', () => {
    const source = readFileSync(new URL('./runtimeDescriptorV1.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("from '@happier-dev/protocol");
    expect(source).not.toContain('from "@happier-dev/protocol');
  });

  it('normalizes valid explicit server URLs', () => {
    const descriptor = buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      providerSessionId: ' opencode-session-1 ',
      serverBaseUrl: ' http://127.0.0.1:4096/path?ignored=true#hash ',
      serverBaseUrlExplicit: true,
    });

    expect(readCanonicalOpenCodeAgentRuntimeDescriptorV1(descriptor)).toEqual({
      providerId: 'opencode',
      backendMode: 'server',
      providerSessionId: 'opencode-session-1',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
  });

  it('does not preserve explicit server URL state for rejected URLs', () => {
    expect(readCanonicalOpenCodeAgentRuntimeDescriptorV1({
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
        serverBaseUrl: 'http://example.com:4096',
        serverBaseUrlExplicit: true,
      },
    })).toEqual({
      providerId: 'opencode',
      backendMode: 'server',
      providerSessionId: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    });
  });
});

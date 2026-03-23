import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeRuntimeDescriptorProviderExtra,
  readOpenCodeRuntimeDescriptorProviderExtra,
} from './opencodeRuntimeDescriptorExtra.js';

describe('opencodeRuntimeDescriptorExtra', () => {
  it('builds and reads a normalized OpenCode runtime handle payload', () => {
    const built = buildOpenCodeRuntimeDescriptorProviderExtra({
      backendMode: 'server',
      vendorSessionId: 'oc_1',
      serverBaseUrl: ' http://127.0.0.1:4096/ ',
      serverBaseUrlExplicit: true,
    });

    expect(readOpenCodeRuntimeDescriptorProviderExtra(built)).toEqual({
      backendMode: 'server',
      vendorSessionId: 'oc_1',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
  });

  it('returns null when the provider extra payload has no usable runtime handle fields', () => {
    expect(readOpenCodeRuntimeDescriptorProviderExtra({ v: 1, runtimeHandle: { serverBaseUrlExplicit: true } })).toBeNull();
  });
});

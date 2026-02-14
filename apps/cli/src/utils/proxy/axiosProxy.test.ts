import { describe, it, expect } from 'vitest';

import { getAxiosProxyOptionsForUrl } from './axiosProxy';

describe('getAxiosProxyOptionsForUrl', () => {
  it('always disables axios native proxy handling', () => {
    const opts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env: {} as NodeJS.ProcessEnv });
    expect(opts).toEqual({ proxy: false });
  });

  it('returns an httpsAgent when a proxy applies', () => {
    const env = { HTTPS_PROXY: 'http://proxy.local:3128' } as NodeJS.ProcessEnv;
    const opts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env });
    expect(opts.proxy).toBe(false);
    expect((opts as any).httpsAgent).toBeTruthy();
  });

  it('does not return an agent when NO_PROXY bypasses', () => {
    const env = { HTTPS_PROXY: 'http://proxy.local:3128', NO_PROXY: '*' } as NodeJS.ProcessEnv;
    const opts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env });
    expect(opts).toEqual({ proxy: false });
  });
});


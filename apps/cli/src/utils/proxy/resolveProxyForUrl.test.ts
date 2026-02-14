import { describe, it, expect } from 'vitest';

import { resolveProxyForUrl } from './resolveProxyForUrl';

describe('resolveProxyForUrl', () => {
  it('uses HTTPS_PROXY for https targets', () => {
    const env = { HTTPS_PROXY: 'http://proxy.local:3128' } as NodeJS.ProcessEnv;
    const res = resolveProxyForUrl({ targetUrl: 'https://example.com/api', env });
    expect(res).toEqual({ mode: 'proxy', proxyUrl: 'http://proxy.local:3128' });
  });

  it('uses HTTP_PROXY for http targets', () => {
    const env = { HTTP_PROXY: 'http://proxy.local:3128' } as NodeJS.ProcessEnv;
    const res = resolveProxyForUrl({ targetUrl: 'http://example.com/api', env });
    expect(res).toEqual({ mode: 'proxy', proxyUrl: 'http://proxy.local:3128' });
  });

  it('bypasses proxy when NO_PROXY is "*"', () => {
    const env = {
      HTTPS_PROXY: 'http://proxy.local:3128',
      NO_PROXY: '*',
    } as NodeJS.ProcessEnv;
    const res = resolveProxyForUrl({ targetUrl: 'https://example.com/api', env });
    expect(res).toEqual({ mode: 'bypass' });
  });

  it('bypasses proxy when NO_PROXY matches the hostname', () => {
    const env = {
      HTTPS_PROXY: 'http://proxy.local:3128',
      NO_PROXY: '.example.com',
    } as NodeJS.ProcessEnv;
    const res = resolveProxyForUrl({ targetUrl: 'https://api.example.com/api', env });
    expect(res).toEqual({ mode: 'bypass' });
  });

  it('normalizes proxy url by adding default port', () => {
    const env = { HTTPS_PROXY: 'http://proxy.local' } as NodeJS.ProcessEnv;
    const res = resolveProxyForUrl({ targetUrl: 'https://example.com/api', env });
    expect(res).toEqual({ mode: 'proxy', proxyUrl: 'http://proxy.local:80' });
  });
});


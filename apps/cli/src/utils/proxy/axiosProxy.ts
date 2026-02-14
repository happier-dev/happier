import type { AxiosRequestConfig } from 'axios';

import { getHttpsProxyAgent } from './agents';
import { resolveProxyForUrl } from './resolveProxyForUrl';

export type AxiosProxyOverrides = Pick<AxiosRequestConfig, 'httpAgent' | 'httpsAgent' | 'proxy'>;

export function getAxiosProxyOptionsForUrl(params: Readonly<{
  targetUrl: string;
  env: NodeJS.ProcessEnv;
}>): AxiosProxyOverrides {
  const resolved = resolveProxyForUrl({ targetUrl: params.targetUrl, env: params.env });

  // Always disable axios's built-in proxy implementation; we handle env + NO_PROXY ourselves.
  if (resolved.mode !== 'proxy') return { proxy: false };

  const agent = getHttpsProxyAgent(resolved.proxyUrl);
  return {
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
  };
}

function resolveAbsoluteUrlFromAxiosConfig(config: Readonly<Pick<AxiosRequestConfig, 'baseURL' | 'url'>>): string | null {
  const rawUrl = typeof config.url === 'string' ? config.url : '';
  if (!rawUrl) return null;

  // Absolute URL.
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;

  // baseURL + relative URL.
  const base = typeof config.baseURL === 'string' ? config.baseURL : '';
  if (!base) return null;
  try {
    return new URL(rawUrl, base).toString();
  } catch {
    return null;
  }
}

let axiosProxySupportInstalled = false;

export function installAxiosProxySupport(params: Readonly<{
  axios: { interceptors: { request: { use: (fn: (cfg: any) => any) => void } } };
  env: NodeJS.ProcessEnv;
}>): void {
  if (axiosProxySupportInstalled) return;
  axiosProxySupportInstalled = true;

  params.axios.interceptors.request.use((config: any) => {
    const targetUrl = resolveAbsoluteUrlFromAxiosConfig(config);
    if (!targetUrl) {
      // Still disable axios' own proxy handling to keep behavior deterministic.
      config.proxy = false;
      return config;
    }

    const overrides = getAxiosProxyOptionsForUrl({ targetUrl, env: params.env });
    Object.assign(config, overrides);
    return config;
  });
}


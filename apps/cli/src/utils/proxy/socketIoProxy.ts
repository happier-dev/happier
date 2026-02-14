import { getHttpsProxyAgent } from './agents';
import { resolveProxyForUrl } from './resolveProxyForUrl';

export function getSocketIoProxyOptions(params: Readonly<{
  targetUrl: string;
  env: NodeJS.ProcessEnv;
}>): { agent?: string | boolean } {
  const resolved = resolveProxyForUrl({ targetUrl: params.targetUrl, env: params.env });
  if (resolved.mode !== 'proxy') return {};
  // engine.io-client types use `string | boolean` here for browser compatibility, but Node allows an Agent.
  // We provide an Agent object at runtime and cast only to satisfy the TS surface.
  return { agent: getHttpsProxyAgent(resolved.proxyUrl) as unknown as boolean };
}

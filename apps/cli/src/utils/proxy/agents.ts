import { HttpsProxyAgent } from 'https-proxy-agent';

// Cache by normalized proxy URL so we don't allocate new agents per request.
const httpsProxyAgentByProxyUrl = new Map<string, HttpsProxyAgent<string>>();

export function getHttpsProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  const existing = httpsProxyAgentByProxyUrl.get(proxyUrl);
  if (existing) return existing;
  const agent = new HttpsProxyAgent(proxyUrl);
  httpsProxyAgentByProxyUrl.set(proxyUrl, agent);
  return agent;
}


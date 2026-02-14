import { isNoProxyMatch, parseNoProxy } from './noProxy';
import { normalizeProxyUrl } from './parseProxyUrl';

export type ProxyResolution =
  | { mode: 'none' }
  | { mode: 'bypass' }
  | { mode: 'proxy'; proxyUrl: string };

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function readProxyValueForTarget(params: Readonly<{ targetProtocol: 'http:' | 'https:'; env: NodeJS.ProcessEnv }>): string | null {
  const { env, targetProtocol } = params;

  // Support both upper and lower-case env vars.
  const httpsProxy = readEnvValue(env, 'HTTPS_PROXY') ?? readEnvValue(env, 'https_proxy');
  const httpProxy = readEnvValue(env, 'HTTP_PROXY') ?? readEnvValue(env, 'http_proxy');

  // For https targets, prefer HTTPS_PROXY but fall back to HTTP_PROXY if that's all we have.
  if (targetProtocol === 'https:') return httpsProxy ?? httpProxy;
  return httpProxy ?? httpsProxy;
}

export function resolveProxyForUrl(params: Readonly<{ targetUrl: string; env: NodeJS.ProcessEnv }>): ProxyResolution {
  let url: URL;
  try {
    url = new URL(params.targetUrl);
  } catch {
    return { mode: 'none' };
  }

  const proxyRaw = readProxyValueForTarget({ targetProtocol: url.protocol === 'https:' ? 'https:' : 'http:', env: params.env });
  if (!proxyRaw) return { mode: 'none' };

  const noProxyRaw = readEnvValue(params.env, 'NO_PROXY') ?? readEnvValue(params.env, 'no_proxy');
  const rules = parseNoProxy(noProxyRaw);
  const targetPort =
    url.port
      ? Number(url.port)
      : url.protocol === 'https:'
        ? 443
        : 80;

  if (rules.length > 0 && isNoProxyMatch({ hostname: url.hostname, port: Number.isFinite(targetPort) ? targetPort : null, rules })) {
    return { mode: 'bypass' };
  }

  const normalized = normalizeProxyUrl(proxyRaw);
  if (!normalized) return { mode: 'none' };

  return { mode: 'proxy', proxyUrl: normalized };
}


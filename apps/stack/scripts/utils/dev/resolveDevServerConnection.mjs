import { normalizeUrlNoTrailingSlash } from '../net/url.mjs';

function parseHttpUrl(raw, { label }) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[dev] invalid ${label}: expected an absolute http(s) URL, got "${value}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[dev] invalid ${label}: expected http:// or https://, got "${value}"`);
  }
  return normalizeUrlNoTrailingSlash(parsed.toString());
}

export function resolveDevServerConnection({
  flags,
  kv,
  env = process.env,
  resolvedLocalUrls,
}) {
  const noServer = flags.has('--no-server');
  const serverUrlFromArg = parseHttpUrl(kv.get('--server-url') ?? '', { label: '--server-url' });
  const serverUrlFromEnv = parseHttpUrl(env.HAPPIER_SERVER_URL ?? '', { label: 'HAPPIER_SERVER_URL' });
  const externalServerUrl = serverUrlFromArg || serverUrlFromEnv;
  const useExternalServer = noServer || Boolean(serverUrlFromArg);

  if (serverUrlFromArg && (kv.has('--server') || kv.has('--server-flavor'))) {
    throw new Error('[dev] --server-url cannot be combined with --server or --server-flavor');
  }

  if (noServer && !externalServerUrl) {
    throw new Error(
      '[dev] --no-server requires an external server URL via --server-url=<http(s)://...> or HAPPIER_SERVER_URL'
    );
  }

  if (useExternalServer) {
    if (!externalServerUrl) {
      throw new Error('[dev] external server URL is required when server is disabled');
    }
    return {
      startServer: false,
      internalServerUrl: externalServerUrl,
      publicServerUrl: externalServerUrl,
      uiApiUrl: externalServerUrl,
      source: serverUrlFromArg ? 'cli-arg' : 'env',
    };
  }

  return {
    startServer: true,
    internalServerUrl: resolvedLocalUrls.internalServerUrl,
    publicServerUrl: resolvedLocalUrls.publicServerUrl,
    uiApiUrl: resolvedLocalUrls.defaultPublicUrl,
    source: 'local',
  };
}

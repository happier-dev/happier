import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// This preload replaces only the provider's network socket in the real daemon.
// The production plugin HTTP adapter deliberately supplies its own dispatcher,
// so environment HTTPS_PROXY by itself cannot reach the recording fixture.
const proxyUrl = process.env.HAPPIER_E2E_DEPLOYMENT_PROVIDER_PROXY;
const caPath = process.env.HAPPIER_E2E_DEPLOYMENT_PROVIDER_CA;
if (proxyUrl && caPath) {
  const requireCli = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url));
  const undici = requireCli('undici/index.js');
  const dispatcher = new undici.ProxyAgent({ uri: proxyUrl, requestTls: { ca: await readFile(caPath) } });
  const nativeFetch = undici.fetch;
  const hosts = new Set(JSON.parse(process.env.HAPPIER_E2E_DEPLOYMENT_PROVIDER_HOSTS ?? '[]'));
  undici.fetch = (input, init) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    return nativeFetch(input, hosts.has(url.hostname) ? { ...init, dispatcher } : init);
  };
}

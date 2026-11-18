import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Only the external GitHub HTTP socket is replaced. Plugin admission,
// repository description, credential selection and Git execution stay real.
const proxy = process.env.HAPPIER_E2E_TRIAGE_GITHUB_PROXY;
const certificate = process.env.HAPPIER_E2E_TRIAGE_GITHUB_CA;
if (proxy && certificate) {
  const requireCli = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url));
  const undici = requireCli('undici/index.js');
  const dispatcher = new undici.ProxyAgent({ uri: proxy, requestTls: { ca: await readFile(certificate) } });
  const external = input => new URL(typeof input === 'object' && 'url' in input ? input.url : String(input)).hostname === 'api.github.com';
  const originalUndiciFetch = undici.fetch;
  undici.fetch = (input, init) => originalUndiciFetch(input, external(input) ? { ...init, dispatcher } : init);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => external(input)
    ? originalUndiciFetch(input, { ...init, dispatcher }) : originalFetch(input, init);
}

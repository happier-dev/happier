import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const undici = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url))('undici/index.js');

/**
 * Route named provider sockets to the fixture in the current process.
 * Patching dispatch also reaches fetch functions Node has already imported.
 * @param {{ proxyUrl: string, caPath: string, hosts: readonly string[] }} input
 */
export async function routeDeploymentProviderHttp({ proxyUrl, caPath, hosts }) {
  const dispatcher = new undici.ProxyAgent({ uri: proxyUrl, requestTls: { ca: await readFile(caPath) } });
  const providerHosts = new Set(hosts);
  const agent = undici.Agent.prototype;
  const original = Object.getOwnPropertyDescriptor(agent, 'dispatch');
  const dispatch = agent.dispatch;
  let forwarding = false;
  agent.dispatch = function (options, handler) {
    if (forwarding || !options?.origin || !providerHosts.has(new URL(options.origin).hostname)) {
      return dispatch.call(this, options, handler);
    }
    // ProxyAgent synchronously delegates to its own Undici Agent.
    forwarding = true;
    try {
      return dispatcher.dispatch(options, handler);
    } finally {
      forwarding = false;
    }
  };
  return async () => {
    if (original) Object.defineProperty(agent, 'dispatch', original);
    else delete agent.dispatch;
    await dispatcher.close();
  };
}

const proxyUrl = process.env.HAPPIER_E2E_DEPLOYMENT_PROVIDER_PROXY;
const caPath = process.env.HAPPIER_E2E_DEPLOYMENT_PROVIDER_CA;
if (proxyUrl && caPath) {
  await routeDeploymentProviderHttp({
    proxyUrl, caPath, hosts: JSON.parse(process.env.HAPPIER_E2E_DEPLOYMENT_PROVIDER_HOSTS ?? '[]'),
  });
}

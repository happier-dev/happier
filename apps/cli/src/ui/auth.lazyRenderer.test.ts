import inspector from 'node:inspector';
import { expect, it } from 'vitest';

it('keeps the interactive renderer and protocol root barrel unloaded through daemon cold admission', async () => {
  const session = new inspector.Session();
  session.connect();
  const scripts: { url: string; scriptId: string }[] = [];
  session.on('Debugger.scriptParsed', ({ params }) => scripts.push(params));
  const call = (method: 'Debugger.enable' | 'HeapProfiler.collectGarbage'): Promise<void> =>
    new Promise((resolve, reject) => session.post(method, (error) => error ? reject(error) : resolve()));
  try {
    await call('Debugger.enable');
    const rendererLoaded = () => scripts.some(({ url }) => /node_modules\/(?:ink|react-reconciler)\//u.test(url));
    const rootLoaded = () => scripts.some(({ url }) => /(?:packages\/protocol\/(?:src|dist)|node_modules\/@happier-dev\/protocol\/dist)\/index\.(?:ts|js)$/u.test(url));
    expect(rendererLoaded()).toBe(false);
    await call('HeapProfiler.collectGarbage');
    const before = process.memoryUsage();
    await import('./auth');
    await call('HeapProfiler.collectGarbage');
    // The same source harness records cold-load memory on RED and GREEN.
    console.info('daemon-auth-cold-load-memory', JSON.stringify({ before, after: process.memoryUsage() }));
    const authRootLoaded = rootLoaded();
    await import('../daemon/startDaemon');
    await call('HeapProfiler.collectGarbage');
    console.info('daemon-entrypoint-cold-load-memory', JSON.stringify({ before, after: process.memoryUsage(),
      protocolScripts: scripts.filter(({ url }) => /packages\/protocol\/src\//u.test(url)).length,
    }));
    if (process.env.SCHEMA_MEMORY_GRAPH === '1') {
      const rootImporters: { url: string; imports: string[] }[] = [];
      for (const { url, scriptId } of scripts) {
        if (!/\/(?:apps|packages)\//u.test(url) || /(?:\.test\.|vitest\.config|daemon-schema-memory\.config)/u.test(url)) continue;
        const source = await new Promise<string>((resolve, reject) => session.post('Debugger.getScriptSource', { scriptId },
          (error, result) => error ? reject(error) : resolve(result.scriptSource)));
        const imports = source.split('\n').filter(line => /__vite_ssr_import__\(["']@happier-dev\/protocol["']/u.test(line));
        if (imports.length) rootImporters.push({ url, imports });
      }
      console.info('daemon-protocol-root-importers', JSON.stringify(rootImporters));
      console.info('daemon-protocol-loaded-barrels', JSON.stringify(scripts
        .map(({ url }) => url.match(/packages\/protocol\/src\/(.+\/index\.(?:ts|js))$/u)?.[1])
        .filter(Boolean)));
      const domains = new Map<string, number>();
      for (const { url } of scripts) {
        const domain = url.match(/packages\/protocol\/src\/([^/?]+)\//u)?.[1];
        if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
      }
      console.info('daemon-protocol-domains', JSON.stringify([...domains].sort((a, b) => b[1] - a[1])));
    }
    expect(rendererLoaded()).toBe(false);
    expect.soft(authRootLoaded, 'auth startup must not load the protocol root').toBe(false);
    expect(rootLoaded(), 'daemon startup must not load the protocol root').toBe(false);
    const startupBarrelFacades = new Set([
      'machines', 'providers/safety', 'runtime/catalog', 'rpc',
      'plugins/ui', 'devices/simulator', 'runtime/input', 'installables/definitions',
      'plugins/manifest', 'actions/executor', 'widgets', 'workflows',
      'sessions/organization', 'sessions/authoring', 'plugins/contributions/ui',
    ]);
    const unrelatedBarrels = scripts.filter(({ url }) => {
      const owner = url.match(/(?:packages\/protocol\/(?:src|dist)|node_modules\/@happier-dev\/protocol\/dist)\/(.+)\/index\.(?:ts|js)$/u)?.[1];
      return owner !== undefined && startupBarrelFacades.has(owner);
    });
    expect(unrelatedBarrels.map(({ url }) => url), 'daemon startup must use canonical leaf owners').toEqual([]);
  } finally {
    session.disconnect();
  }
}, 180_000);

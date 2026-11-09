import inspector from 'node:inspector';
import { expect, it, vi } from 'vitest';

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
    // A failed admission always identifies the importing module; opt-in graph
    // diagnostics remain available for successful memory measurements.
    if (rootLoaded() || process.env.SCHEMA_MEMORY_GRAPH === '1') {
      const rootImporters: { url: string; imports: string[] }[] = [];
      for (const { url, scriptId } of scripts) {
        if (!/\/(?:apps|packages)\//u.test(url) || /(?:\.test\.|vitest\.config|daemon-schema-memory\.config)/u.test(url)) continue;
        const source = await new Promise<string>((resolve, reject) => session.post('Debugger.getScriptSource', { scriptId },
          (error, result) => error ? reject(error) : resolve(result.scriptSource)));
        const imports = source.split('\n').filter(line => /(?:__vite_ssr_import__|\bimport\b).*?(?:["']@happier-dev\/protocol["']|protocol\/(?:src|dist)\/index\.(?:ts|js))/u.test(line));
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
    const acpRuntimeScripts = scripts.filter(({ url }) => /(?:node_modules\/@agentclientprotocol\/sdk\/|\/agent\/acp\/(?:AcpBackend|runtime\/publicSession\/createPublicAcpSession)\.(?:ts|js)$)/u.test(url));
    expect(acpRuntimeScripts.map(({ url }) => url), 'idle daemon admission must not load an unused ACP runtime').toEqual([]);
    const startupBarrelFacades = new Set([
      'machines', 'providers/safety', 'runtime/catalog', 'rpc',
      'plugins/ui', 'devices/simulator', 'runtime/input', 'installables/definitions',
      'plugins/manifest', 'actions/executor', 'widgets', 'workflows',
      'sessions/organization', 'plugins/contributions/ui',
    ]);
    // sessions/authoring/index constructs the canonical authoring value schemas
    // consumed by resume requests and Runner launch manifests; it is a schema
    // owner, not an unrelated forwarding facade.
    const unrelatedBarrels = scripts.filter(({ url }) => {
      const owner = url.match(/(?:packages\/protocol\/(?:src|dist)|node_modules\/@happier-dev\/protocol\/dist)\/(.+)\/index\.(?:ts|js)$/u)?.[1];
      return owner !== undefined && startupBarrelFacades.has(owner);
    });
    expect(unrelatedBarrels.map(({ url }) => url), 'daemon startup must use canonical leaf owners').toEqual([]);
  } finally {
    session.disconnect();
  }
}, 180_000);

type SchemaConstruction = Readonly<{
  owner: string;
  flavor: 'classic' | 'mini';
  type: string;
}>;

function readSchemaConstruction(): readonly SchemaConstruction[] {
  // The diagnostic setup owns this test-only native observation boundary.
  const census = (globalThis as typeof globalThis & {
    __daemonSchemaCensus?: { read(): readonly SchemaConstruction[] };
  }).__daemonSchemaCensus;
  if (!census) throw new Error('Schema census setup must precede CLI setup');
  return census.read();
}

it.runIf(process.env.SCHEMA_MEMORY_CENSUS === '1')('observes native Classic and Mini schema construction', async () => {
  const classic = await import('zod');
  const mini = await import('zod/mini');
  const before = readSchemaConstruction().length;
  const classicSchema = classic.object({ id: classic.string() });
  const miniSchema = mini.object({ id: mini.string() });

  expect(readSchemaConstruction().slice(before).map(({ flavor, type }) => ({ flavor, type }))).toEqual([
    { flavor: 'classic', type: 'string' }, { flavor: 'classic', type: 'object' },
    { flavor: 'mini', type: 'string' }, { flavor: 'mini', type: 'object' },
  ]);
  expect(classicSchema.parse({ id: 'accepted' })).toEqual({ id: 'accepted' });
  expect(miniSchema.parse({ id: 'accepted' })).toEqual({ id: 'accepted' });
  expect(classicSchema.safeParse({ id: 1 }).success).toBe(false);
  expect(miniSchema.safeParse({ id: 1 }).success).toBe(false);
});

it.runIf(process.env.SCHEMA_MEMORY_CENSUS === '1')('keeps unused host and plugin schema graphs cold until real parse demand', async () => {
  vi.resetModules();
  const before = readSchemaConstruction().length;
  const [usage, cursor] = await Promise.all([
    import('../api/usage'),
    import('../../../../packages/plugins/cursor/src/agent/acp/extensions/schemas'),
  ]);
  const owners = [
    'apps/cli/src/api/usage.ts',
    'packages/plugins/cursor/src/agent/acp/extensions/schemas.ts',
  ];
  const imported = readSchemaConstruction().slice(before)
    .filter(({ owner }) => owners.some(path => owner.includes(path)));
  const eager = imported.filter(({ type }) => type !== 'lazy');
  console.info('daemon-unused-schema-construction', JSON.stringify({
    nestedSchemas: eager.length, nativeLazyFacades: imported.length - eager.length,
  }));
  expect(eager).toEqual([]);

  expect(usage.UsageSchema.parse({ input_tokens: 1, output_tokens: 2 })).toMatchObject({
    input_tokens: 1, output_tokens: 2,
  });
  expect(usage.UsageSchema.safeParse({ input_tokens: -1, output_tokens: 2 }).success).toBe(false);
  const question = {
    questions: [{ id: 'q', prompt: 'Pick', options: [{ id: 'one', label: 'One' }] }],
  };
  expect(cursor.cursorAskQuestionRequestSchema.parse(question).questions[0]?.id).toBe('q');
  const afterFirstParse = readSchemaConstruction().length;
  expect(cursor.cursorAskQuestionRequestSchema.parse(question).questions[0]?.id).toBe('q');
  expect(readSchemaConstruction().slice(afterFirstParse)
    .filter(({ owner, type }) => type !== 'lazy' && owner.includes(owners[1]!))).toEqual([]);
  expect(cursor.cursorAskQuestionRequestSchema.safeParse({ questions: [] }).success).toBe(false);
}, 180_000);

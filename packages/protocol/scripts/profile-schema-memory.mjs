// Development benchmark, not a product memory ceiling. From the repository root:
// hstack-exec -- node --experimental-transform-types --expose-gc
//   packages/protocol/scripts/profile-schema-memory.mjs protocol --native
// Add --eager for the process-local construction control, --census for live
// instance counts (instrumented memory is not comparable to the plain probe).
// classic / mini / core compare independent, equivalent strict-object families.
// Census instrumentation is separate from the uninstrumented memory probe.
import inspector from 'node:inspector';
import { registerHooks, createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const mode = process.argv[2] ?? 'protocol';
const census = process.argv.includes('--census');
const eager = process.argv.includes('--eager');
const native = census || eager || process.argv.includes('--native');
const require = createRequire(new URL('../package.json', import.meta.url));
const samples = [];
const seen = new WeakSet();
const outsideStacks = [];
if (native) {
  Error.stackTraceLimit = 40;
  // Avoid tsx's source-map loader reentering module evaluation from a sampled
  // constructor. Raw call sites are sufficient for allocation ownership.
  Error.prepareStackTrace = (_error, frames) => frames.map(frame =>
    `${frame.getFunctionName() ?? ''} (${frame.getFileName()}:${frame.getLineNumber()})`).join('\n');
  globalThis.__protocolSchemaSample = (schema, definition) => {
    if (seen.has(schema)) return;
    seen.add(schema);
    const stack = new Error().stack ?? '';
    const frames = stack.split('\n');
    const ownerFrame = frames.find(frame => /packages\/protocol\/(?:src|dist)\//u.test(frame));
    const owner = ownerFrame?.match(/packages\/protocol\/(?:src|dist)\/[^:)]+/u)?.[0] ?? 'outside protocol';
    if (!ownerFrame && outsideStacks.length < 3) outsideStacks.push(stack);
    samples.push({ ref: new WeakRef(schema), owner, type: definition.type,
      derived: /(?:clone|extend|merge|pick|omit|partial|optional|nullable|strict|check)\s*\(/u.test(stack) });
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL) {
        const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (!existsSync(new URL(specifier, context.parentURL)) && existsSync(candidate)) return nextResolve(candidate.href, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (eager && url.endsWith('/packages/protocol/src/lazyZodSchema.ts')) {
        return { ...result, format: 'module', source: 'export function lazyZodSchema(create) { return create(); } export function lazyDefinition(create) { return create(); }' };
      }
      if (eager && url.endsWith('/packages/protocol/src/plugins/actions/internalProtocolZodAdapter.ts')) {
        const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
        return { ...result, source: source.replace('return z.lazy(() => {', '{').replace(/\n  \}\);\n\}\s*$/u, '\n  }\n}') };
      }
      if (census && /\/zod\/v4\/classic\/schemas\.js$/u.test(url)) {
        const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
        return { ...result, source: source.replace(
          'core.$ZodType.init(inst, def);',
          'core.$ZodType.init(inst, def); globalThis.__protocolSchemaSample(inst, def);',
        ) };
      }
      return result;
    },
  });
}
const session = new inspector.Session();
session.connect();
const call = (method, params = {}) => new Promise((accept, reject) =>
  session.post(method, params, (error, result) => error ? reject(error) : accept(result)));
await call('HeapProfiler.collectGarbage');
const before = process.memoryUsage();
await call('HeapProfiler.startSampling', { samplingInterval: 16384 });
const start = performance.now();
if (['classic', 'mini', 'core'].includes(mode)) {
  const z = await import(pathToFileURL(require.resolve(mode === 'classic' ? 'zod' : `zod/v4/${mode}`)).href);
  const schemas = [];
  const make = mode === 'core'
    ? () => new z.$ZodObject({ type: 'object', shape: {
      id: new z.$ZodString({ type: 'string' }),
      count: new z.$ZodOptional({ type: 'optional', innerType: new z.$ZodNumber({ type: 'number', checks: [] }) }),
      tags: new z.$ZodArray({ type: 'array', element: new z.$ZodString({ type: 'string' }) }),
    }, catchall: new z.$ZodNever({ type: 'never' }) })
    : mode === 'mini'
      ? () => z.strictObject({ id: z.string(), count: z.optional(z.number()), tags: z.array(z.string()) })
      : () => z.object({ id: z.string(), count: z.number().optional(), tags: z.array(z.string()) }).strict();
  for (let i = 0; i < 5000; i++) schemas.push(make());
  await call('HeapProfiler.collectGarbage');
  const after = process.memoryUsage();
  const schema = schemas[0];
  const parse = mode === 'core' ? value => z.parse(schema, value) : value => schema.parse(value);
  const input = { id: 'session', count: 3, tags: ['a', 'b'] };
  for (let i = 0; i < 10000; i++) parse(input);
  const parseStart = performance.now();
  for (let i = 0; i < 100000; i++) parse(input);
  console.log(JSON.stringify({ mode, node: process.version, zod: require('zod/package.json').version,
    before, after, schemaFamilies: schemas.length, heapBytesPerFamily: (after.heapUsed - before.heapUsed) / schemas.length,
    schemaNodesPerFamily: 7, heapBytesPerSchemaNode: (after.heapUsed - before.heapUsed) / (schemas.length * 7),
    parseMs: performance.now() - parseStart, parses: 100000, retained: schemas.length }));
} else {
  const unregister = native ? () => {} : (await import('tsx/esm/api')).register();
  const entry = mode === 'protocol' ? 'packages/protocol/src/index.ts' : mode;
  await import(pathToFileURL(resolve(entry)).href);
  await new Promise(accept => setImmediate(accept));
  await call('HeapProfiler.collectGarbage');
  const after = process.memoryUsage();
  const { profile } = await call('HeapProfiler.stopSampling');
  const sizes = new Map();
  function walk(node, owner) {
    if (/packages\/protocol\/(?:src|dist)\//u.test(node.callFrame.url)) owner = node.callFrame.url;
    sizes.set(owner, (sizes.get(owner) ?? 0) + node.selfSize);
    for (const child of node.children) walk(child, owner);
  }
  walk(profile.head, 'outside protocol');
  const counts = new Map();
  let live = 0;
  let derivedLive = 0;
  for (const sample of samples) {
    if (!sample.ref.deref()) continue;
    live++;
    const row = counts.get(sample.owner) ?? { instances: 0, derived: 0 };
    row.instances++;
    if (sample.derived) { row.derived++; derivedLive++; }
    counts.set(sample.owner, row);
  }
  console.log(JSON.stringify({ mode, census, eager, node: process.version, before, after, elapsedMs: performance.now() - start,
    created: samples.length, live, derivedLive, outsideStacks,
    ownersByLiveCount: [...counts].sort((a,b) => b[1].instances-a[1].instances).slice(0,20),
    outsideSampledLiveBytes: sizes.get('outside protocol'),
    ownersBySampledLiveBytes: [...sizes].filter(([owner]) => owner !== 'outside protocol').sort((a,b) => b[1]-a[1]).slice(0,20) }));
  unregister();
}
session.disconnect();

import { registerHooks } from 'node:module';
import inspector from 'node:inspector';
import { afterAll } from 'vitest';

const samples = [];
const seen = new WeakSet();
const previousStackLimit = Error.stackTraceLimit;
Error.stackTraceLimit = 40;
const unattributedStacks = [];
globalThis.__daemonSchemaSample = (schema) => {
  if (seen.has(schema)) return;
  seen.add(schema);
  const stack = new Error().stack ?? '';
  const frame = stack.split('\n').find(line => /\/(?:packages|apps|node_modules)\//u.test(line)
    && !/\/(?:zod|vite|vitest|tsx|@vitest)\//u.test(line)
    && !line.includes('/daemon-schema-census.setup.mjs'));
  const owner = frame?.match(/(?:packages|apps|node_modules)\/[^:)\n]+/u)?.[0] ?? 'unattributed';
  if (!frame && unattributedStacks.length < 3) unattributedStacks.push(stack);
  samples.push({ ref: new WeakRef(schema), owner,
    derived: /(?:clone|extend|merge|pick|omit|partial|optional|nullable|strict|check)\s*\(/u.test(stack) });
};
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!/\/zod\/v4\/classic\/schemas\.js$/u.test(url)) return result;
    const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
    return { ...result, source: source.replace('core.$ZodType.init(inst, def);',
      'core.$ZodType.init(inst, def); globalThis.__daemonSchemaSample(inst);') };
  },
});
afterAll(async () => {
  await new Promise(accept => setImmediate(accept));
  const session = new inspector.Session();
  session.connect();
  await new Promise((accept, reject) => session.post('HeapProfiler.collectGarbage',
    error => error ? reject(error) : accept()));
  session.disconnect();
  const owners = new Map();
  let live = 0;
  let derivedLive = 0;
  for (const sample of samples) {
    if (!sample.ref.deref()) continue;
    live++;
    const row = owners.get(sample.owner) ?? { instances: 0, derived: 0 };
    row.instances++;
    if (sample.derived) { row.derived++; derivedLive++; }
    owners.set(sample.owner, row);
  }
  console.info('daemon-schema-census', JSON.stringify({ created: samples.length, live, derivedLive, unattributedStacks,
    ownersByLiveCount: [...owners].sort((a, b) => b[1].instances - a[1].instances).slice(0, 20) }));
  hook.deregister();
  Error.stackTraceLimit = previousStackLimit;
  delete globalThis.__daemonSchemaSample;
});

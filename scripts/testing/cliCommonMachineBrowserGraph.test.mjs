import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

test('UI Machines and bootstrap entries have no Node built-in dependencies', async () => {
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  const nodeEdges = new Set();
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    stdin: { resolveDir: fileURLToPath(new URL('../../apps/ui/', import.meta.url)), contents: `export * from '@happier-dev/cli-common/machines/managed';
      export * from '@happier-dev/cli-common/machines/managed/provisioners';
      export * from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';` },
    bundle: true,
    platform: 'browser',
    conditions: ['happier-source'],
    write: false,
    metafile: true,
    treeShaking: false,
    logLevel: 'silent',
    plugins: [{ name: 'reject-node-edges', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        // Let the browser resolver apply dependency-owned browser:false shims
        // (for example TweetNaCl's optional crypto require).
        if (!args.path.startsWith('node:') || !builtins.has(args.path)) return;
        nodeEdges.add(`${args.importer}: ${args.path}`);
        return { path: args.path, external: true };
      });
    } }],
  });
  const queue = [['<stdin>']];
  const seen = new Set();
  const chains = [];
  for (const chain of queue) {
    const id = chain.at(-1);
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependency of result.metafile.inputs[id]?.imports ?? []) {
      const next = [...chain, dependency.path];
      if (builtins.has(dependency.path)) chains.push(next.join(' → '));
      else if (!dependency.external) queue.push(next);
    }
  }
  assert.deepEqual([...nodeEdges].sort(), [], chains.join('\n'));
});

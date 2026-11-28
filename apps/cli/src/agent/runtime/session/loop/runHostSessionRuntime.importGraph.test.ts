import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { projectPath } from '@/projectPath';

const cliRoot = projectPath();
const { build } = createRequire(join(cliRoot, 'package.json'))('esbuild') as typeof import('esbuild');

// Every Runner evaluates this static graph at start, and each module stays resident.
// HTTP servers (Fastify) and the Undici client belong to rare paths (a shared Provider
// run, the Session MCP client side, API-token automation custody); they load on first use.
it('keeps server and client HTTP stacks out of the Runner start graph', async () => {
  const entryPoint = 'src/agent/runtime/session/loop/runHostSessionRuntime.ts';
  const { metafile } = await build({
    absWorkingDir: cliRoot, entryPoints: [entryPoint], outdir: 'unused-runner-graph',
    platform: 'node', format: 'esm', bundle: true, write: false, metafile: true,
    // Workspace packages are part of the Runner bundle, so their edges count too.
    conditions: ['happier-source'], external: ['onnxruntime-node', '*.node'], logLevel: 'silent',
  });
  const inputs = metafile!.inputs;
  const eager = new Set<string>();
  const pending = [entryPoint];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (eager.has(path)) continue;
    eager.add(path);
    for (const dependency of inputs[path]?.imports ?? []) {
      if (!dependency.external && dependency.kind !== 'dynamic-import') pending.push(dependency.path);
    }
  }
  const packageOf = (path: string) => /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path.replaceAll('\\', '/'))?.[1];
  const coldPackages = ['fastify', 'undici'];
  // The packages are still bundled behind their first-use imports.
  expect(coldPackages.filter(name => Object.keys(inputs).some(path => packageOf(path) === name))).toEqual(coldPackages);
  expect([...new Set([...eager].map(packageOf).filter(name => coldPackages.includes(name!)))]).toEqual([]);
}, 240_000);

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';

const cliRoot = projectPath();
const { build } = createRequire(join(cliRoot, 'package.json'))('esbuild') as typeof import('esbuild');

describe('daemon transport import demand', () => {
  it.each([
    'src/daemon/controlHttp.ts',
    'src/plugins/discovery/remote/acquisition.ts',
    'src/plugins/runtime/invocation/services/managedServicesOwner.ts',
  ])('keeps external Undici cold until a transport operation in %s', async entryPoint => {
    const { metafile } = await build({
      absWorkingDir: cliRoot, entryPoints: [entryPoint], outdir: 'unused-transport-graph',
      platform: 'node', format: 'esm', bundle: true, write: false, metafile: true,
      // Public workspace packages and the native ML addon are separate runtime
      // boundaries. Undici and all reachable CLI transport code stay real.
      conditions: ['happier-source'], external: ['@happier-dev/*', 'onnxruntime-node'], logLevel: 'silent',
    });
    const inputs = metafile!.inputs;
    const eager = new Set<string>();
    const visit = (path: string) => {
      if (eager.has(path)) return;
      eager.add(path);
      const input = inputs[path];
      if (!input) throw new Error(`Missing bundled transport input: ${path}`);
      for (const dependency of input.imports) {
        if (!dependency.external && dependency.kind !== 'dynamic-import') visit(dependency.path);
      }
    };
    visit(entryPoint);
    const isUndici = (path: string) => path.replaceAll('\\', '/').includes('/node_modules/undici/');
    const undiciInputs = Object.keys(inputs).filter(isUndici);
    // Externalizing or deleting the real transport cannot satisfy cold loading.
    expect(undiciInputs.length, 'first-use graph retains the real Undici implementation').toBeGreaterThan(0);
    const eagerUndiciInputs = [...eager].filter(isUndici);
    expect(eagerUndiciInputs, 'owner import must not evaluate external Undici').toEqual([]);
    console.info(JSON.stringify({ entryPoint, undiciInputs: undiciInputs.length, eagerUndiciInputs: eagerUndiciInputs.length }));
  });
});

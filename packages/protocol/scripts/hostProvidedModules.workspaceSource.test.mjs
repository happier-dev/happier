import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { deriveHostProvidedProtocolModules, HOST_PROVIDED_SUBPATHS_FILE } from './hostProvidedModules.mjs';

// Metro resolves workspace packages through their `happier-source` export. Protocol
// export generation runs before its workspace dependencies build their dist, so a
// new (still unbuilt) dependency must resolve from source here too.
test('a workspace dependency without built dist is analyzed from its happier-source export', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'protocol-host-provided-'));
  try {
    const dependency = join(packageRoot, 'node_modules/@happier-dev/fixture-contracts');
    await mkdir(join(dependency, 'src'), { recursive: true });
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@happier-dev/fixture-contracts', type: 'module',
      exports: { './v1': { 'happier-source': './src/v1.ts', types: './dist/v1.d.ts', default: './dist/v1.js' } } }));
    await writeFile(join(dependency, 'src/v1.ts'), 'export const contract = 1;\n');
    await writeFile(join(packageRoot, 'src/consumer.ts'), "export { contract } from '@happier-dev/fixture-contracts/v1';\n");
    const { files } = await deriveHostProvidedProtocolModules({ packageRoot, publicSources: new Set(['consumer']), exports: {} });
    const subpaths = files.find(file => file.path === join(packageRoot, HOST_PROVIDED_SUBPATHS_FILE));
    expect(subpaths?.next).toContain('@happier-dev/protocol/consumer');
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

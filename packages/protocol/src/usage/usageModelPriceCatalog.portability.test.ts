import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import { bundledUsageModelPriceCatalog, resolveUsageModelPrice } from './usageModelPriceCatalog.js';

describe('bundled model price catalog portability', () => {
  it.each(['browser', 'node'] as const)('loads the complete catalog in a compiled %s bundle', async (platform) => {
    const chunks: string[] = [];
    const externalImports: string[] = [];
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'model-price-catalog-portability',
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue;
            externalImports.push(...chunk.imports, ...chunk.dynamicImports);
            chunks.push(chunk.code);
          }
        },
      }],
      ssr: { noExternal: true },
      build: {
        target: 'es2022',
        minify: false,
        write: false,
        ssr: platform === 'node',
        lib: {
          entry: fileURLToPath(new URL('./usageModelPriceCatalog.ts', import.meta.url)),
          name: 'usagePrices',
          formats: [platform === 'browser' ? 'iife' : 'es'],
        },
      },
    });
    expect(externalImports).toEqual([]);
    expect(chunks).toHaveLength(1);
    const expected = {
      catalog: bundledUsageModelPriceCatalog,
      resolved: resolveUsageModelPrice('gpt-5.4'),
    };
    if (platform === 'browser') {
      // Deliberately omit Node globals: the browser must consume the JSON inline.
      const browser = { URL };
      const result: unknown = runInNewContext(`${chunks[0]}; ({
        catalog: usagePrices.bundledUsageModelPriceCatalog,
        resolved: usagePrices.resolveUsageModelPrice('gpt-5.4'),
      })`, browser);
      expect(result).toEqual(expected);
    } else {
      const directory = await mkdtemp(join(tmpdir(), 'happier-price-catalog-'));
      try {
        const output = join(directory, 'catalog.mjs');
        await writeFile(output, chunks[0]!);
        const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
          const prices = await import(process.argv[1]);
          process.stdout.write(JSON.stringify({
            catalog: prices.bundledUsageModelPriceCatalog,
            resolved: prices.resolveUsageModelPrice('gpt-5.4'),
          }));
        `, pathToFileURL(output).href], { encoding: 'utf8' });
        expect(JSON.parse(result)).toEqual(expected);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

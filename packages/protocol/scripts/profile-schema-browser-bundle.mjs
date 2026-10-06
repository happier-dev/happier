// Protocol's browser contribution, not a replacement for a loaded UI measurement.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const eager = process.argv.includes('--eager');
const result = await build({
  entryPoints: ['packages/protocol/src/index.ts'],
  bundle: true, platform: 'browser', format: 'esm', minify: true,
  write: false, metafile: true,
  plugins: eager ? [{
    name: 'schema-eager-control',
    setup(builder) {
      builder.onLoad({ filter: /\/lazyZodSchema\.ts$/ }, () => ({
        contents: 'export function lazyZodSchema(create) { return create(); } export function lazyDefinition(create) { return create(); }',
        loader: 'ts',
      }));
      builder.onLoad({ filter: /\/internalProtocolZodAdapter\.ts$/ }, async ({ path }) => {
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(path, 'utf8');
        return { contents: source.replace('return z.lazy(() => {', '{').replace(/\n  \}\);\n\}\s*$/u, '\n  }\n}'), loader: 'ts' };
      });
    },
  }] : [],
});
const output = result.outputFiles[0].contents;
console.log(JSON.stringify({ eager, platform: 'browser', node: process.version,
  bytes: output.length, gzipBytes: gzipSync(output).length, inputs: Object.keys(result.metafile.inputs).length }));

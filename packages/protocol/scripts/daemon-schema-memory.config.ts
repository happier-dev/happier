// Diagnostic configuration: composes the real CLI harness, without mocking
// protocol validation or replacing production imports.
import { defineConfig, mergeConfig } from 'vitest/config';
import cliConfig from '../../../apps/cli/vitest.config.js';

export default mergeConfig(cliConfig, defineConfig({
  plugins: process.env.SCHEMA_MEMORY_EAGER === '1' ? [{
    name: 'daemon-schema-eager-control',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/packages/protocol/src/lazyZodSchema.ts')) {
        return 'export function lazyZodSchema(create) { return create(); } export function lazyDefinition(create) { return create(); }';
      }
      if (id.endsWith('/packages/protocol/src/plugins/actions/internalProtocolZodAdapter.ts')) {
        return source.replace('return z.lazy(() => {', '{').replace(/\n  \}\);\n\}\s*$/u, '\n  }\n}');
      }
    },
  }] : [],
  test: { setupFiles: process.env.SCHEMA_MEMORY_CENSUS === '1'
    ? [new URL('./daemon-schema-census.setup.mjs', import.meta.url).pathname] : [] },
}));

// Diagnostic configuration: composes the real CLI harness, without mocking
// protocol validation or replacing production imports.
import { defineConfig, mergeConfig } from 'vitest/config';
import cliConfig from '../../../apps/cli/vitest.config.js';

const config = mergeConfig(cliConfig, defineConfig({
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
}));

if (process.env.SCHEMA_MEMORY_CENSUS === '1') {
  // Install native observation before the CLI locale setup imports Mini.
  const setupFiles = config.test?.setupFiles;
  config.test = {
    ...config.test,
    setupFiles: [new URL('./daemon-schema-census.setup.mjs', import.meta.url).pathname,
      ...(Array.isArray(setupFiles) ? setupFiles : setupFiles ? [setupFiles] : [])],
  };
}

export default config;

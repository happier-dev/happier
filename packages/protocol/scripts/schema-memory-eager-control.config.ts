// Diagnostic control for the construction benchmark. This is not an
// acceptance harness: it restores eager construction only in this process.
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [{
    name: 'schema-memory-eager-control',
    enforce: 'pre',
    transform(_source, id) {
      if (!id.endsWith('/packages/protocol/src/lazyZodSchema.ts')) return;
      return 'export function lazyZodSchema(create) { return create(); } export function lazyDefinition(create) { return create(); }';
    },
  }],
  test: { globals: false, environment: 'node', maxWorkers: 1 },
});

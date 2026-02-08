import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('libsodium web shim package exports', () => {
  it('declares the deep CJS wrapper path used by the web shim', () => {
    const entryPath = require.resolve('libsodium-wrappers');
    const packageJsonPath = join(dirname(dirname(dirname(entryPath))), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(packageJson.exports ?? {}, './dist/modules/libsodium-wrappers.js')).toBe(true);
  });
});

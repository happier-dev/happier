import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('apps/cli package publish contract', () => {
  it('bundles critical crypto/runtime deps for global installs', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(here, '..', '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      bundledDependencies?: unknown;
      dependencies?: Record<string, string> | undefined;
    };

    const bundled = Array.isArray(packageJson.bundledDependencies)
      ? packageJson.bundledDependencies.map((v) => String(v))
      : [];

    for (const name of ['base64-js', '@noble/hashes', 'tweetnacl']) {
      expect(packageJson.dependencies?.[name]).toBeTruthy();
      expect(bundled).toContain(name);
    }
  });
});


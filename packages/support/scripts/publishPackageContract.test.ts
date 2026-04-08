import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('support package publish contract', () => {
  const supportRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  it('declares the published support bin entrypoint', () => {
    const supportPackageJsonPath = resolve(supportRoot, 'package.json');
    const supportPackageJson = JSON.parse(readFileSync(supportPackageJsonPath, 'utf8')) as {
      bin?: unknown;
    };

    expect(supportPackageJson.bin).toEqual({
      hsupport: './bin/hsupport.mjs',
    });
  });
});

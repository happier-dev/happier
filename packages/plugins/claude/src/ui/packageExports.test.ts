import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type PackageExportEntry = Readonly<{
  'react-native'?: string;
  default?: string;
  types?: string;
}>;

type ClaudePackageJson = Readonly<{
  exports?: Record<string, PackageExportEntry | string>;
}>;

describe('Claude UI package exports', () => {
  it('pins the UI subpath to built output for React Native bundlers', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(
      readFileSync(resolve(testDir, '../../package.json'), 'utf8'),
    ) as ClaudePackageJson;
    const uiExport = packageJson.exports?.['./ui'];

    expect(uiExport).toEqual(expect.objectContaining({
      'react-native': './dist/ui/index.js',
      default: './dist/ui/index.js',
      types: './dist/ui/index.d.ts',
    }));
  });
});

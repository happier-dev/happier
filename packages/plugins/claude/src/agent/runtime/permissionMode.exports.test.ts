import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type PackageExportEntry = Readonly<{
    default?: string;
    types?: string;
}>;

type ClaudePackageJson = Readonly<{
    exports?: Record<string, PackageExportEntry | string>;
}>;

describe('Claude permission mode package exports', () => {
    it('publishes a narrow agent runtime permission mode subpath', () => {
        const testDir = dirname(fileURLToPath(import.meta.url));
        const packageJson = JSON.parse(
            readFileSync(resolve(testDir, '../../../package.json'), 'utf8'),
        ) as ClaudePackageJson;

        expect(packageJson.exports?.['./agent/runtime/permissionMode']).toEqual({
            types: './dist/agent/runtime/permissionMode.d.ts',
            default: './dist/agent/runtime/permissionMode.js',
        });
    });
});

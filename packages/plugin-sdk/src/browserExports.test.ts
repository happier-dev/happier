import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function readPackageJson(path: URL): { exports?: Record<string, unknown> } {
    return JSON.parse(readFileSync(path, 'utf8')) as { exports?: Record<string, unknown> };
}

describe('browser-safe package exports', () => {
    it('routes browser root and manifest imports through browser-specific entrypoints', () => {
        const packageJson = readPackageJson(new URL('../package.json', import.meta.url));

        expect(packageJson.exports).toHaveProperty('.', {
            types: './dist/index.d.ts',
            browser: './dist/index.browser.js',
            default: './dist/index.js',
        });
        expect(packageJson.exports).toHaveProperty('./manifest', {
            types: './dist/manifest.d.ts',
            browser: './dist/manifest.browser.js',
            default: './dist/manifest.js',
        });
    });

    it('publishes usage from the stable subpath and retains the deprecated compatibility path', () => {
        const packageJson = readPackageJson(new URL('../package.json', import.meta.url));

        expect(packageJson.exports).toMatchObject({
            './usage': {
                types: './dist/usage.d.ts',
                default: './dist/usage.js',
            },
            './experimental/usage': {
                types: './dist/experimental/usage.d.ts',
                default: './dist/experimental/usage.js',
            },
        });
    });

    it('uses protocol subpath exports for browser-safe SDK helper dependencies', () => {
        const protocolPackageJson = readPackageJson(new URL('../../protocol/package.json', import.meta.url));

        expect(protocolPackageJson.exports).toMatchObject({
            './plugins/hooks': {
                types: './dist/plugins/hooks/catalog.d.ts',
                default: './dist/plugins/hooks/catalog.js',
            },
            './plugins/contributions/agentSettings': {
                types: './dist/plugins/contributions/agentSettings.d.ts',
                default: './dist/plugins/contributions/agentSettings.js',
            },
            './plugins/contributions/browser': {
                types: './dist/plugins/contributions/browser/index.d.ts',
                default: './dist/plugins/contributions/browser/index.js',
            },
            './plugins/contributions/ui': {
                types: './dist/plugins/contributions/ui/index.d.ts',
                default: './dist/plugins/contributions/ui/index.js',
            },
        });
    });
});

import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('browser public toolchain packet', () => {
    it('bundles and loads the browser entry without build-realm or Node edges', async () => {
        const browserEntry = resolve(import.meta.dirname, './index.ts');
        const emittedModules = new Set<string>();
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            plugins: [{
                name: 'browser-public-toolchain-entry',
                resolveId(id) {
                    return id === 'virtual:browser-public-toolchain-entry' ? `\0${id}` : null;
                },
                load(id) {
                    if (id !== '\0virtual:browser-public-toolchain-entry') return null;
                    return `export { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from ${JSON.stringify(browserEntry)};`;
                },
                generateBundle() {
                    for (const id of this.getModuleIds()) emittedModules.add(id);
                },
            }],
            build: {
                minify: false,
                target: 'es2022',
                write: false,
                rollupOptions: {
                    input: 'virtual:browser-public-toolchain-entry',
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
            },
        });

        expect([...emittedModules].filter((id) => (
            id.includes('node:')
            || id.includes('__vite-browser-external')
            || id.includes('/ui/build/bin.')
            || id.includes('/ui/build/buildUiArtifacts.')
        ))).toEqual([]);

        const outputs = Array.isArray(result) ? result : [result];
        const entry = outputs
            .flatMap((item) => 'output' in item ? item.output : [])
            .find((item) => item.type === 'chunk' && item.isEntry);
        expect(entry?.type).toBe('chunk');
        if (!entry || entry.type !== 'chunk') throw new Error('Vite did not emit the browser packet entry.');

        const browserModule = await import(`data:text/javascript,${encodeURIComponent(entry.code)}`);
        expect(browserModule.PUBLIC_TOOLCHAIN_COMPATIBILITY_V1).toMatchObject({
            schemaVersion: 1,
            framework: { runtime: '1' },
        });
    }, 60_000);
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('External Session takeover browser graph', () => {
    it('reaches the bounded runtime-descriptor Protocol leaf without the Protocol root', async () => {
        const sdkEntry = resolve(import.meta.dirname, './externalSessionTakeover.ts');
        const protocolRoot = resolve(import.meta.dirname, '../../../protocol/src/index.ts');
        const protocolAgentsLeaf = resolve(import.meta.dirname, '../../../protocol/src/plugins/agents.ts');
        const runtimeDescriptorLeaf = resolve(
            import.meta.dirname,
            '../../../protocol/src/sessions/metadata/runtimeDescriptorV1.ts',
        );
        const emittedModules = new Set<string>();
        const protocolPackage = JSON.parse(readFileSync(
            resolve(import.meta.dirname, '../../../protocol/package.json'),
            'utf8',
        )) as { exports?: Record<string, unknown> };

        expect(protocolPackage.exports).toHaveProperty(
            './sessions/metadata/runtime-descriptor',
            {
                types: './dist/sessions/metadata/runtimeDescriptorV1.d.ts',
                default: './dist/sessions/metadata/runtimeDescriptorV1.js',
            },
        );

        await build({
            configFile: false,
            logLevel: 'silent',
            resolve: {
                alias: [
                    {
                        find: '@happier-dev/protocol/plugins/agents',
                        replacement: protocolAgentsLeaf,
                    },
                    {
                        find: '@happier-dev/protocol/sessions/metadata/runtime-descriptor',
                        replacement: runtimeDescriptorLeaf,
                    },
                    { find: /^@happier-dev\/protocol$/, replacement: protocolRoot },
                ],
            },
            plugins: [{
                name: 'external-session-takeover-browser-graph',
                generateBundle() {
                    for (const id of this.getModuleIds()) emittedModules.add(id);
                },
            }],
            build: {
                minify: false,
                target: 'es2022',
                write: false,
                rollupOptions: {
                    input: sdkEntry,
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
            },
        });

        expect([...emittedModules]).not.toContain(protocolRoot);
        expect([...emittedModules].filter((id) => (
            id.includes('node:') || id.includes('__vite-browser-external')
        ))).toEqual([]);
        expect([...emittedModules].filter((id) => (
            id === runtimeDescriptorLeaf
        ))).toHaveLength(1);
    }, 60_000);
});

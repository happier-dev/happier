import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { isUnsupportedBrowserBuiltin, rejectUnsupportedBrowserBuiltins } from '../test-support/browserBuiltins.js';

describe('External Session takeover browser graph', () => {
    it('reaches the bounded runtime-descriptor Protocol leaf without the Protocol root', async () => {
        const sdkEntry = resolve(import.meta.dirname, './externalSessionTakeover.ts');
        const protocolRoot = resolve(import.meta.dirname, '../../../protocol/src/index.ts');
        const protocolAgentsLeaf = resolve(import.meta.dirname, '../../../protocol/src/plugins/agents.ts');
        const runtimeDescriptorLeaf = resolve(
            import.meta.dirname,
            '../../../protocol/src/sessions/metadata/runtimeDescriptorV1.ts',
        );
        const opaqueIdentifierLeaf = resolve(
            import.meta.dirname,
            '../../../protocol/src/strings/opaqueIdentifier.ts',
        );
        const emittedModules = new Set<string>();
        await build({
            configFile: resolve(import.meta.dirname, '../../vitest.source.config.ts'),
            logLevel: 'silent',
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
                    ...rejectUnsupportedBrowserBuiltins,
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
        expect([...emittedModules]).not.toContain(protocolAgentsLeaf);
        expect([...emittedModules].filter(isUnsupportedBrowserBuiltin)).toEqual([]);
        expect([...emittedModules].filter((id) => (
            id === runtimeDescriptorLeaf
        ))).toHaveLength(1);
        expect([...emittedModules].filter((id) => (
            id === opaqueIdentifierLeaf
        ))).toHaveLength(1);
    }, 60_000);
});

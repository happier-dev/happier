import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('Protocol browser bundle initialization', () => {
    it('initializes the public Action and plugin-permission schemas together', async () => {
        const protocolActionsEntry = resolve(import.meta.dirname, '../../protocol/src/actions/index.ts');
        const protocolPermissionsEntry = resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/permissions/v1.ts',
        );
        const moduleGraph = new Map<string, readonly string[]>();
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            plugins: [{
                name: 'protocol-browser-bundle-entry',
                resolveId(id) {
                    return id === 'virtual:protocol-browser-bundle-entry' ? `\0${id}` : null;
                },
                load(id) {
                    if (id !== '\0virtual:protocol-browser-bundle-entry') return null;
                    return `
                        export {
                            ACTION_SETTINGS_OPT_IN_PLACEMENTS,
                            ActionSpecSchema,
                        } from ${JSON.stringify(protocolActionsEntry)};
                        export {
                            PluginPermissionCapabilityV1Schema,
                            PluginPermissionSubjectV1Schema,
                        } from ${JSON.stringify(protocolPermissionsEntry)};
                    `;
                },
                generateBundle() {
                    for (const id of this.getModuleIds()) {
                        moduleGraph.set(id, this.getModuleInfo(id)?.importedIds ?? []);
                    }
                },
            }],
            build: {
                minify: false,
                rollupOptions: {
                    input: 'virtual:protocol-browser-bundle-entry',
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
                target: 'es2022',
                write: false,
            },
        });

        const permissionGrantsModule = [...moduleGraph.keys()].find((id) =>
            id.endsWith('/packages/protocol/src/plugins/permissions/grants.ts'),
        );
        const permissionV1Module = [...moduleGraph.keys()].find((id) =>
            id.endsWith('/packages/protocol/src/plugins/permissions/v1.ts'),
        );
        expect(permissionGrantsModule).toBeDefined();
        expect(permissionV1Module).toBeDefined();
        if (!permissionGrantsModule || !permissionV1Module) {
            throw new Error('Vite omitted the Protocol permission modules');
        }
        expect(moduleGraph.get(permissionGrantsModule)).not.toContain(permissionV1Module);

        const buildResults = Array.isArray(result) ? result : [result];
        const outputs = buildResults.flatMap((item) => {
            if (!('output' in item)) throw new Error('Vite unexpectedly started a watch build');
            return item.output;
        });
        const bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry);
        expect(bundle?.type).toBe('chunk');
        if (!bundle || bundle.type !== 'chunk') throw new Error('Vite did not emit a JavaScript chunk');
        const exports = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`) as Readonly<{
            ACTION_SETTINGS_OPT_IN_PLACEMENTS: readonly string[];
            ActionSpecSchema: Readonly<{ safeParse(value: unknown): unknown }>;
            PluginPermissionCapabilityV1Schema: Readonly<{ options: readonly unknown[] }>;
            PluginPermissionSubjectV1Schema: Readonly<{ options: readonly unknown[] }>;
        }>;

        expect(exports.ACTION_SETTINGS_OPT_IN_PLACEMENTS).toEqual(['agent_input_chips']);
        expect(exports.ActionSpecSchema.safeParse).toBeTypeOf('function');
        expect(exports.PluginPermissionCapabilityV1Schema.options.length).toBeGreaterThan(0);
        expect(exports.PluginPermissionSubjectV1Schema.options).toHaveLength(2);
    }, 60_000);
});

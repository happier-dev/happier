import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build, normalizePath, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';

function readPackageJson(path: URL): { exports?: Record<string, unknown> } {
    return JSON.parse(readFileSync(path, 'utf8')) as { exports?: Record<string, unknown> };
}

async function protocolBrowserSources(): Promise<Plugin> {
    // Reuse the source lane's resolver: nested Vite builds do not inherit Vitest plugins.
    const { createWorkspacePackageSourcesPlugin }: {
        createWorkspacePackageSourcesPlugin: (
            packages: readonly Readonly<{ packageName: string; packageSourceRoot: string }>[],
            name: string,
            options: Readonly<{ exportConditions: readonly string[] }>,
        ) => Plugin;
    } = await import(resolve(import.meta.dirname, '../../../scripts/testing/vitestWorkspacePackageResolution.ts'));
    return createWorkspacePackageSourcesPlugin([
        { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(import.meta.dirname, '../../protocol/src') },
    ], 'plugin-sdk-browser-protocol-sources', { exportConditions: ['browser'] });
}

const voiceRealmEntries = {
    neutral: normalizePath(resolve(import.meta.dirname, './voice/index.ts')),
    client: normalizePath(resolve(import.meta.dirname, './voice/client.ts')),
    speech: normalizePath(resolve(import.meta.dirname, './voice/speech.ts')),
} as const;

type VoiceRealmEntry = keyof typeof voiceRealmEntries;

const voiceRealmSpecifiers = {
    neutral: '@happier-dev/plugin-sdk/voice',
    client: '@happier-dev/plugin-sdk/voice/client',
    speech: '@happier-dev/plugin-sdk/voice/speech',
} as const satisfies Record<VoiceRealmEntry, string>;

async function collectVoiceRealmModules(
    entries: readonly VoiceRealmEntry[],
    injectedValueEdge?: Readonly<{ from: VoiceRealmEntry; to: VoiceRealmEntry }>,
): Promise<ReadonlySet<string>> {
    const emittedModules = new Set<string>();
    await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
            alias: [
                { find: voiceRealmSpecifiers.client, replacement: voiceRealmEntries.client },
                { find: voiceRealmSpecifiers.speech, replacement: voiceRealmEntries.speech },
                { find: voiceRealmSpecifiers.neutral, replacement: voiceRealmEntries.neutral },
            ],
        },
        plugins: [{
            name: 'plugin-voice-realm-entry',
            resolveId(id) {
                return id === 'virtual:plugin-voice-realm-entry' ? `\0${id}` : null;
            },
            load(id) {
                if (id !== '\0virtual:plugin-voice-realm-entry') return null;
                return `${entries.map((entry) => (
                    `import ${JSON.stringify(voiceRealmEntries[entry])};`
                )).join('\n')}\nexport const voiceRealmProbe = true;`;
            },
            transform(code, id) {
                if (!injectedValueEdge || id !== voiceRealmEntries[injectedValueEdge.from]) {
                    return null;
                }
                return `${code}\nimport ${JSON.stringify(voiceRealmSpecifiers[injectedValueEdge.to])};`;
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
                external: (id) => id.startsWith('@happier-dev/')
                    && id !== '@happier-dev/plugin-sdk'
                    && !id.startsWith('@happier-dev/plugin-sdk/'),
                input: 'virtual:plugin-voice-realm-entry',
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    inlineDynamicImports: true,
                },
            },
        },
    });
    return emittedModules;
}

function emittedVoiceRealmEntries(modules: ReadonlySet<string>): VoiceRealmEntry[] {
    return (Object.entries(voiceRealmEntries) as [VoiceRealmEntry, string][])
        .filter(([, entry]) => modules.has(entry))
        .map(([realm]) => realm)
        .sort();
}

describe('browser-safe package exports', () => {
    it('does not publish retired usage compatibility paths', () => {
        const packageJson = readPackageJson(new URL('../package.json', import.meta.url));

        expect(packageJson.exports).not.toHaveProperty('./usage');
        expect(packageJson.exports).not.toHaveProperty('./experimental/usage');
    });

    it('keeps hosted-web helpers and the client entry out of Node-only Protocol modules', async () => {
        const protocolClientEntry = resolve(import.meta.dirname, '../../protocol/src/plugins/ui/client.ts');
        const hostedWebEntry = resolve(import.meta.dirname, './ui/hostedWeb.ts');
        const clientEntry = resolve(import.meta.dirname, './ui/client.ts');
        const emittedModules = new Set<string>();
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            resolve: {
                alias: {
                    '@happier-dev/protocol/plugins/ui/client': protocolClientEntry,
                },
            },
            plugins: [{
                name: 'plugin-ui-browser-realm-entry',
                resolveId(id) {
                    return id === 'virtual:plugin-ui-browser-realm-entry' ? `\0${id}` : null;
                },
                load(id) {
                    if (id !== '\0virtual:plugin-ui-browser-realm-entry') return null;
                    return `
                        export { defineHostedWebBridgeMessage } from ${JSON.stringify(hostedWebEntry)};
                        export { createPluginUiHostApiClient } from ${JSON.stringify(clientEntry)};
                    `;
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
                    input: 'virtual:plugin-ui-browser-realm-entry',
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
            },
        });

        const forbiddenModules = [...emittedModules].filter((id) =>
            id.includes('/actions/actionSpecs.')
            || id.includes('/sessions/external/')
            || id.includes('/crypto/accountScopedCipher.')
            || id.includes('__vite-browser-external'),
        );
        expect(forbiddenModules).toEqual([]);

        const buildResults = Array.isArray(result) ? result : [result];
        const entryChunk = buildResults
            .flatMap((item) => 'output' in item ? item.output : [])
            .find((item) => item.type === 'chunk' && item.isEntry);
        expect(entryChunk?.type).toBe('chunk');
        if (!entryChunk || entryChunk.type !== 'chunk') {
            throw new Error('Vite did not emit the Plugin UI browser-realm entry chunk');
        }
        expect(entryChunk.code).not.toContain('node:crypto');
    }, 60_000);

    it.each([
        { title: 'keeps every portable manifest runtime value out of Node and host-state modules', injectNodeImport: false },
        { title: 'detects a Node-only import added to the portable manifest graph', injectNodeImport: true },
    ])('$title', async ({ injectNodeImport }) => {
        const manifestPortableEntry = resolve(import.meta.dirname, './manifest.browser.ts');
        const emittedModules = new Set<string>();
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            plugins: [await protocolBrowserSources(), {
                name: 'plugin-manifest-browser-realm-entry',
                resolveId(id) {
                    return id === 'virtual:plugin-manifest-browser-realm-entry' ? `\0${id}` : null;
                },
                load(id) {
                    if (id !== '\0virtual:plugin-manifest-browser-realm-entry') return null;
                    return `export * from ${JSON.stringify(manifestPortableEntry)};`;
                },
                transform(code, id) {
                    if (!injectNodeImport || id !== normalizePath(manifestPortableEntry)) return null;
                    return `${code}\nimport 'node:fs';`;
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
                    input: 'virtual:plugin-manifest-browser-realm-entry',
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
            },
        });

        expect(emittedModules).toContain(normalizePath(manifestPortableEntry));

        const forbiddenModules = [...emittedModules].filter((id) =>
            id.includes('node:')
            || id.includes('__vite-browser-external')
            || id.includes('/crypto/')
            || id.includes('/marketplace/')
            || id.includes('/plugins/installations/')
        );
        if (injectNodeImport) {
            expect(forbiddenModules.some((id) => id.includes('__vite-browser-external'))).toBe(true);
        } else {
            expect(forbiddenModules).toEqual([]);
        }

        const buildResults = Array.isArray(result) ? result : [result];
        const entryChunk = buildResults
            .flatMap((item) => 'output' in item ? item.output : [])
            .find((item) => item.type === 'chunk' && item.isEntry);
        expect(entryChunk?.type).toBe('chunk');
        if (!entryChunk || entryChunk.type !== 'chunk') {
            throw new Error('Vite did not emit the Plugin manifest browser-realm entry chunk');
        }
        expect(entryChunk.code).not.toContain('node:crypto');
    }, 60_000);

    it('keeps Voice runtime entrypoints on their declared realm side of the bundle graph', async () => {
        const neutralModules = await collectVoiceRealmModules(['neutral']);
        const clientModules = await collectVoiceRealmModules(['neutral', 'client']);
        const daemonModules = await collectVoiceRealmModules(['neutral', 'speech']);

        expect(emittedVoiceRealmEntries(neutralModules)).toEqual(['neutral']);
        expect(emittedVoiceRealmEntries(clientModules)).toEqual(['client', 'neutral']);
        expect(emittedVoiceRealmEntries(daemonModules)).toEqual(['neutral', 'speech']);

        const neutralWithForbiddenClientValueImport = await collectVoiceRealmModules(
            ['neutral'],
            { from: 'neutral', to: 'client' },
        );
        const neutralWithForbiddenSpeechValueImport = await collectVoiceRealmModules(
            ['neutral'],
            { from: 'neutral', to: 'speech' },
        );
        const clientWithForbiddenSpeechValueImport = await collectVoiceRealmModules(
            ['neutral', 'client'],
            { from: 'client', to: 'speech' },
        );
        const daemonWithForbiddenClientValueImport = await collectVoiceRealmModules(
            ['neutral', 'speech'],
            { from: 'speech', to: 'client' },
        );
        expect(emittedVoiceRealmEntries(neutralWithForbiddenClientValueImport))
            .toEqual(['client', 'neutral']);
        expect(emittedVoiceRealmEntries(neutralWithForbiddenSpeechValueImport))
            .toEqual(['neutral', 'speech']);
        expect(emittedVoiceRealmEntries(clientWithForbiddenSpeechValueImport))
            .toEqual(['client', 'neutral', 'speech']);
        expect(emittedVoiceRealmEntries(daemonWithForbiddenClientValueImport))
            .toEqual(['client', 'neutral', 'speech']);
    }, 60_000);

    it('keeps the public Event Automation setup-result schema out of Node-only Protocol branches', async () => {
        const packageJson = readPackageJson(new URL('../package.json', import.meta.url));
        const eventsEntry = resolve(import.meta.dirname, './events/index.browser.ts');
        const emittedModules = new Set<string>();
        expect(packageJson.exports?.['./events']).toMatchObject({
            types: './dist/events/index.d.ts',
            browser: {
                'happier-source': './src/events/index.browser.ts',
                default: './dist/events/index.browser.js',
            },
            default: './dist/events/index.js',
        });
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            plugins: [await protocolBrowserSources(), {
                name: 'plugin-events-browser-realm-entry',
                resolveId(id) {
                    return id === 'virtual:plugin-events-browser-realm-entry' ? `\0${id}` : null;
                },
                load(id) {
                    if (id !== '\0virtual:plugin-events-browser-realm-entry') return null;
                    return `export {
                        PluginEventAutomationSetupResultV1Schema,
                        PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                        PluginEventAutomationHistoryGapResetActionInputV1Schema,
                        PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
                        PluginEventAutomationHistoryGapResetActionResultV1Schema,
                    } from ${JSON.stringify(eventsEntry)};`;
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
                    external: (id) => id.startsWith('node:'),
                    input: 'virtual:plugin-events-browser-realm-entry',
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
            },
        });

        const forbiddenModules = [...emittedModules].filter((id) => (
            id.includes('node:')
            || id.includes('__vite-browser-external')
            || id.includes('/crypto/accountScopedCipher.')
            || id.includes('/plugins/data/collectionsV1.')
            || id.includes('/machines/identity/installationIdentity.')
            || id.includes('/tweetnacl/')
        ));
        expect(forbiddenModules).toEqual([]);

        const buildResults = Array.isArray(result) ? result : [result];
        const entryChunk = buildResults
            .flatMap((item) => 'output' in item ? item.output : [])
            .find((item) => item.type === 'chunk' && item.isEntry);
        expect(entryChunk?.type).toBe('chunk');
        if (!entryChunk || entryChunk.type !== 'chunk') {
            throw new Error('Vite did not emit the Plugin Event Automation setup-result entry chunk');
        }
        expect(entryChunk.code).not.toContain('node:crypto');
    }, 60_000);
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build, normalizePath } from 'vite';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function readPackageJson(path: URL): { exports?: Record<string, unknown> } {
    return JSON.parse(readFileSync(path, 'utf8')) as { exports?: Record<string, unknown> };
}

function readNamedExports(path: string): readonly string[] {
    const source = readFileSync(path, 'utf8');
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names: string[] = [];
    for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
        if (!ts.isNamedExports(statement.exportClause)) continue;
        names.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
    return names.sort();
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
    it('publishes the one registration transaction through browser and React Native conditions', () => {
        const packageJson = readPackageJson(new URL('../package.json', import.meta.url));

        expect(packageJson.exports).toHaveProperty('./host/registration', {
            types: './dist/host/registration/index.d.ts',
            browser: './dist/host/registration/index.js',
            'react-native': './dist/host/registration/index.js',
            default: './dist/host/registration/index.js',
        });
    });

    it('bundles the canonical registration transaction and host-proven Action failure factory', async () => {
        const registrationEntry = normalizePath(resolve(
            import.meta.dirname,
            './host/registration/index.ts',
        ));
        const protocolManifestEntry = normalizePath(resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/manifest/index.ts',
        ));
        const protocolAgentsEntry = normalizePath(resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/agents.ts',
        ));
        const emittedModules = new Set<string>();
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            resolve: {
                alias: [
                    {
                        find: '@happier-dev/protocol/plugins/manifest',
                        replacement: protocolManifestEntry,
                    },
                    {
                        find: '@happier-dev/protocol/plugins/agents',
                        replacement: protocolAgentsEntry,
                    },
                ],
            },
            plugins: [{
                name: 'plugin-registration-browser-realm-entry',
                resolveId(id) {
                    return id === 'virtual:plugin-registration-browser-realm-entry'
                        ? `\0${id}`
                        : null;
                },
                load(id) {
                    if (id !== '\0virtual:plugin-registration-browser-realm-entry') return null;
                    return `export {
                        createPluginActionHandlerNotStartedError,
                        createPluginRegistrationScope,
                    } from ${JSON.stringify(registrationEntry)};`;
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
                    external: (id) => id.startsWith('@happier-dev/'),
                    input: 'virtual:plugin-registration-browser-realm-entry',
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
            },
        });

        expect([...emittedModules].filter((id) => (
            id.includes('node:') || id.includes('__vite-browser-external')
        ))).toEqual([]);

        const buildResults = Array.isArray(result) ? result : [result];
        const entryChunk = buildResults
            .flatMap((item) => 'output' in item ? item.output : [])
            .find((item) => item.type === 'chunk' && item.isEntry);
        expect(entryChunk?.type).toBe('chunk');
        if (!entryChunk || entryChunk.type !== 'chunk') {
            throw new Error('Vite did not emit the registration transaction entry chunk');
        }
        expect(entryChunk.exports).toEqual([
            'createPluginActionHandlerNotStartedError',
            'createPluginRegistrationScope',
        ]);
    }, 60_000);

    it('publishes the canonical root and manifest entrypoints without retired browser aliases', () => {
        const packageJson = readPackageJson(new URL('../package.json', import.meta.url));
        const browserRootExports = readNamedExports(resolve(
            import.meta.dirname,
            './index.browser.ts',
        ));

        expect(packageJson.exports).toHaveProperty('.', {
            types: './dist/index.d.ts',
            browser: './dist/index.browser.js',
            default: './dist/index.js',
        });
        expect(packageJson.exports).toHaveProperty('./manifest', {
            types: './dist/manifest/index.d.ts',
            default: './dist/manifest/index.js',
        });
        expect(browserRootExports).toContain('PluginClientApi');
        expect(browserRootExports).not.toContain('PluginApi');
    });

    it('keeps runtime target-aware types on the browser root while protocol authoring owns author contracts', () => {
        const browserRootSource = readFileSync(new URL('./index.browser.ts', import.meta.url), 'utf8');
        const protocolPublicSource = resolve(
            import.meta.dirname,
            './protocol/index.public.ts',
        );
        const protocolBrowserSource = resolve(
            import.meta.dirname,
            './protocol/index.browser.ts',
        );
        const contributionsPublicSource = resolve(
            import.meta.dirname,
            './contributions/index.public.ts',
        );
        const contributionsBrowserSource = resolve(
            import.meta.dirname,
            './contributions/index.browser.ts',
        );
        const targetedAuthoringExportEnd = "} from './targetedContributionAuthoring.js';";
        const targetedAuthoringExportEndIndex = browserRootSource.lastIndexOf(targetedAuthoringExportEnd);
        const targetedAuthoringTypeExportStart = browserRootSource.lastIndexOf(
            'export type {',
            targetedAuthoringExportEndIndex,
        );
        if (targetedAuthoringExportEndIndex < 0 || targetedAuthoringTypeExportStart < 0) {
            throw new Error('targeted_contribution_browser_type_export_missing');
        }
        const exportedNames = browserRootSource.slice(
            targetedAuthoringTypeExportStart + 'export type {'.length,
            targetedAuthoringExportEndIndex,
        )
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name.length > 0);

        expect(exportedNames).toEqual(expect.arrayContaining([
            'DefinedContributionPointRef',
            'DefinedContributionPoints',
            'ContributionAdmittedEntry',
            'ContributionOperationContracts',
            'ContributionSurfaceHandles',
        ]));
        for (const authorOnlyExport of [
            'ContributionActionDangerLevel',
            'ContributionActionSurface',
            'ContributionProtocol',
            'defineContributionPoint',
            'defineContributionProtocol',
            'defineProtocolUtf8String',
            'defineProtocolUniqueArray',
        ]) {
            expect(exportedNames, authorOnlyExport).not.toContain(authorOnlyExport);
        }
        expect(browserRootSource).not.toContain(
            "export {\n    defineContributionPoint,\n    defineContributionProtocol,\n} from './targetedContributionAuthoring.js';",
        );
        expect(readNamedExports(protocolPublicSource)).toEqual(expect.arrayContaining([
            'defineProtocolObject',
            'defineProtocolUtf8String',
        ]));
        expect(readNamedExports(contributionsPublicSource)).toEqual(expect.arrayContaining([
            'defineContributionPoint',
            'defineContributionProtocol',
            'PluginTargetedContributionSelectionV1Schema',
        ]));
        expect(readFileSync(protocolBrowserSource, 'utf8').trim())
            .toBe("export * from './index.public.js';");
        expect(readFileSync(contributionsBrowserSource, 'utf8').trim())
            .toBe("export * from './index.public.js';");
    });

    it('does not publish retired usage compatibility paths', () => {
        const packageJson = readPackageJson(new URL('../package.json', import.meta.url));

        expect(packageJson.exports).not.toHaveProperty('./usage');
        expect(packageJson.exports).not.toHaveProperty('./experimental/usage');
    });

    it('uses protocol subpath exports for browser-safe SDK helper dependencies', () => {
        const protocolPackageJson = readPackageJson(new URL('../../protocol/package.json', import.meta.url));
        const hostedWebSource = readFileSync(new URL('./ui/hostedWeb.ts', import.meta.url), 'utf8');
        const clientTransportSource = readFileSync(new URL('./ui/clientTransport.ts', import.meta.url), 'utf8');
        const voiceClientSource = readFileSync(new URL('./voice/client.ts', import.meta.url), 'utf8');

        expect(protocolPackageJson.exports).toMatchObject({
            './actions/actionInputJsonSchema': {
                types: './dist/actions/actionInputJsonSchema.d.ts',
                default: './dist/actions/actionInputJsonSchema.js',
            },
            './actions/actionInputVoiceGuidance': {
                types: './dist/actions/actionInputVoiceGuidance.d.ts',
                default: './dist/actions/actionInputVoiceGuidance.js',
            },
            './plugins/manifest': {
                types: './dist/plugins/manifest/index.d.ts',
                default: './dist/plugins/manifest/index.js',
            },
            './plugins/ui': {
                types: './dist/plugins/ui/index.d.ts',
                default: './dist/plugins/ui/index.js',
            },
            './plugins/ui/client': {
                types: './dist/plugins/ui/client.d.ts',
                default: './dist/plugins/ui/client.js',
            },
            './plugins/hooks': {
                types: './dist/plugins/hooks/catalog.d.ts',
                default: './dist/plugins/hooks/catalog.js',
            },
            './plugins/contributions/browser': {
                types: './dist/plugins/contributions/browser/index.d.ts',
                default: './dist/plugins/contributions/browser/index.js',
            },
            './plugins/contributions/voice': {
                types: './dist/plugins/contributions/voiceProviders.d.ts',
                default: './dist/plugins/contributions/voiceProviders.js',
            },
            './plugins/contributions/ui': {
                types: './dist/plugins/contributions/ui/index.d.ts',
                default: './dist/plugins/contributions/ui/index.js',
            },
            './voice/modelPacks/contributionV1': {
                types: './dist/voice/modelPacks/contributionV1.d.ts',
                default: './dist/voice/modelPacks/contributionV1.js',
            },
            './voice/providerOperations': {
                types: './dist/voice/providerOperations.d.ts',
                default: './dist/voice/providerOperations.js',
            },
            './voice/sessionBinding': {
                types: './dist/voice/sessionBinding.d.ts',
                default: './dist/voice/sessionBinding.js',
            },
        });
        expect(protocolPackageJson.exports).not.toHaveProperty('./plugins/contributions/agentSettings');
        expect(hostedWebSource).not.toMatch(
            /^import\s*\{[^}]*\}\s*from ['"]@happier-dev\/protocol['"];/m,
        );
        expect(hostedWebSource).toContain("from '@happier-dev/protocol/plugins/ui/client'");
        expect(clientTransportSource).not.toMatch(/from ['"]@happier-dev\/protocol['"]/u);
        expect(clientTransportSource).toContain("from '@happier-dev/protocol/plugins/ui/client'");
        expect(voiceClientSource).not.toMatch(/from ['"]@happier-dev\/protocol['"]/u);
        expect(voiceClientSource).toContain("from '@happier-dev/protocol/actions/actionSpecs'");
        expect(voiceClientSource).toContain("from '@happier-dev/protocol/voice/providerOperations'");
        expect(voiceClientSource).toContain("from '@happier-dev/protocol/voice/realtime'");
        expect(voiceClientSource).toContain("from '@happier-dev/protocol/voice/sessionBinding'");
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

    it('keeps every portable manifest runtime value out of Node and host-state modules', async () => {
        const manifestPortableEntry = resolve(import.meta.dirname, './manifest.browser.ts');
        const protocolManifestDeclarationEntry = resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/manifest/declaration.ts',
        );
        const emittedModules = new Set<string>();
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            resolve: {
                alias: {
                    '@happier-dev/protocol/plugins/manifest/declaration': protocolManifestDeclarationEntry,
                },
            },
            plugins: [{
                name: 'plugin-manifest-browser-realm-entry',
                resolveId(id) {
                    return id === 'virtual:plugin-manifest-browser-realm-entry' ? `\0${id}` : null;
                },
                load(id) {
                    if (id !== '\0virtual:plugin-manifest-browser-realm-entry') return null;
                    return `
                        export {
                            compilePluginJsonSchema,
                            createPluginContributionIdentity,
                            isValidPluginJsonSchemaValue,
                        } from ${JSON.stringify(manifestPortableEntry)};
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
                    input: 'virtual:plugin-manifest-browser-realm-entry',
                    preserveEntrySignatures: 'strict',
                    output: {
                        format: 'es',
                        inlineDynamicImports: true,
                    },
                },
            },
        });

        expect(emittedModules).toContain(protocolManifestDeclarationEntry);

        const forbiddenModules = [...emittedModules].filter((id) =>
            id.includes('node:')
            || id.includes('__vite-browser-external')
            || id.includes('/crypto/')
            || id.includes('/marketplace/')
            || id.includes('/plugins/installations/')
        );
        expect(forbiddenModules).toEqual([]);

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
        const eventsEntry = resolve(import.meta.dirname, './events/index.ts');
        const protocolRoot = resolve(import.meta.dirname, '../../protocol/src/index.ts');
        const protocolEventSetupResultEntry = resolve(
            import.meta.dirname,
            '../../protocol/src/automations/automationEventSetupResultV1.ts',
        );
        const protocolEventHistoryGapResetActionEntry = resolve(
            import.meta.dirname,
            '../../protocol/src/automations/automationEventHistoryGapResetActionV1.ts',
        );
        const protocolEventEntry = resolve(
            import.meta.dirname,
            '../../protocol/src/automations/automationEventV1.ts',
        );
        const emittedModules = new Set<string>();
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            resolve: {
                alias: [
                    {
                        find: '@happier-dev/protocol/automations/event-setup-result',
                        replacement: protocolEventSetupResultEntry,
                    },
                    {
                        find: '@happier-dev/protocol/automations/event',
                        replacement: protocolEventEntry,
                    },
                    {
                        find: '@happier-dev/protocol/automations/event-history-gap-reset-action',
                        replacement: protocolEventHistoryGapResetActionEntry,
                    },
                    { find: /^@happier-dev\/protocol$/u, replacement: protocolRoot },
                ],
            },
            plugins: [{
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
            || id.includes('/crypto/canonicalDigest.')
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

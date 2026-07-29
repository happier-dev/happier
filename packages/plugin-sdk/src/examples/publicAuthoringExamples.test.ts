import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
    ingestPluginManifestV2,
    PluginManifestV2Schema,
    type ParsedPluginManifestV2,
} from '@happier-dev/protocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
    PluginVoiceAccountOperationService,
    PluginVoiceProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk/runtime';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const examplesRoot = join(packageRoot, 'examples');
const packageJsonPath = join(packageRoot, 'package.json');

const requiredExamples = [
    'descriptor-only',
    'hosted-web',
    'react-native-installed',
    'react-native-dev-hot-reload',
    'multi-mode-fallback',
] as const;

async function listTypeScriptFiles(dir: string): Promise<readonly string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            return listTypeScriptFiles(entryPath);
        }
        return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
    }));
    return files.flat().sort();
}

function readExampleManifest(exampleName: (typeof requiredExamples)[number]): ParsedPluginManifestV2 {
    const manifestPath = join(examplesRoot, exampleName, '.happier-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const parsed = PluginManifestV2Schema.safeParse(manifest);
    const diagnostics = parsed.success
        ? ''
        : `\n${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('\n')}`;
    expect(
        parsed.success,
        `${exampleName}/.happier-plugin/plugin.json must match the protocol manifest schema${diagnostics}`,
    ).toBe(true);
    if (!parsed.success) {
        throw new Error(parsed.error.message);
    }
    return parsed.data;
}

function readPackageExportSpecifiers(): ReadonlySet<string> {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        name: string;
        exports: Record<string, unknown>;
    };
    return new Set([
        packageJson.name,
        ...Object.keys(packageJson.exports)
            .filter((subpath) => !subpath.startsWith('./internal/'))
            .map((subpath) => `${packageJson.name}${subpath.slice(1)}`),
    ]);
}

function shouldCopyExamplePath(source: string): boolean {
    return !source.split(/[\\/]+/u).some((segment) => segment === 'node_modules' || segment === 'dist');
}

function copyExamplesOutsideWorkspace(): string {
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-plugin-sdk-examples-'));
    cpSync(examplesRoot, tempRoot, {
        recursive: true,
        filter: shouldCopyExamplePath,
    });
    mkdirSync(join(tempRoot, 'node_modules', '@happier-dev'), { recursive: true });
    symlinkSync(packageRoot, join(tempRoot, 'node_modules', '@happier-dev', 'plugin-sdk'), 'dir');
    return tempRoot;
}

describe('public SDK authoring examples', { timeout: 60_000 }, () => {
    it('uses one cold JSON manifest per external example with no ordinary startup activation', () => {
        const exampleNames = [...requiredExamples, 'public-authoring'] as const;

        for (const exampleName of exampleNames) {
            const manifestPath = join(examplesRoot, exampleName, '.happier-plugin', 'plugin.json');
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
            const parsed = PluginManifestV2Schema.safeParse(manifest);

            expect(
                parsed.success,
                `${exampleName}/.happier-plugin/plugin.json must be the protocol-valid author source`,
            ).toBe(true);
            expect(
                existsSync(join(examplesRoot, exampleName, 'manifest.ts')),
                `${exampleName} must not teach an executable TypeScript manifest`,
            ).toBe(false);
            if (exampleName === 'public-authoring') {
                expect(
                    existsSync(join(examplesRoot, exampleName, 'voiceModelPack.ts')),
                    'manifest contribution data must remain in the cold JSON manifest',
                ).toBe(false);
            }
            const sourceEntryPath = join(examplesRoot, exampleName, 'src', 'index.ts');
            if (existsSync(sourceEntryPath)) {
                expect(readFileSync(sourceEntryPath, 'utf8')).not.toMatch(
                    /\bexport\s+const\s+manifest\b/u,
                );
            }
            if (parsed.success) {
                expect(parsed.data.activation?.events ?? []).not.toContainEqual({ kind: 'startup' });
            }
        }
    });

    it('import only public @happier-dev/plugin-sdk entry points', async () => {
        const allowedSpecifiers = readPackageExportSpecifiers();
        const files = await listTypeScriptFiles(examplesRoot);
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];
        for (const filePath of files) {
            const sourceFile = ts.createSourceFile(
                filePath,
                readFileSync(filePath, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TS,
            );
            sourceFile.forEachChild((node) => {
                if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
                    return;
                }
                const specifier = node.moduleSpecifier.text;
                if (specifier.startsWith('@happier-dev/plugin-ui')) {
                    violations.push(`${relative(packageRoot, filePath)} imports ${specifier}`);
                    return;
                }
                if (
                    specifier.startsWith('@happier-dev/plugin-sdk')
                    && !allowedSpecifiers.has(specifier)
                ) {
                    violations.push(`${relative(packageRoot, filePath)} imports ${specifier}`);
                }
            });
        }

        expect(violations).toEqual([]);
    });

    it('uses the canonical manifest, agent-runtime, and UI build entrypoints without predecessor authoring APIs', async () => {
        const files = await listTypeScriptFiles(examplesRoot);
        const violations: string[] = [];

        for (const filePath of files) {
            const relativePath = relative(packageRoot, filePath);
            const source = readFileSync(filePath, 'utf8');
            for (const retired of [
                'defineAcpBackend',
                'beginTurnLifecycle',
                'startOrLoadSession',
                'waitForTurnCompletion',
                '@happier-dev/plugin-sdk/ui/hostApiClient',
                '@happier-dev/plugin-sdk/ui/reactNativeBuild',
                '@happier-dev/plugin-sdk/ui/reactNativeWebBuild',
                '@happier-dev/plugin-sdk/ui/hostedWebBuild',
            ]) {
                if (source.includes(retired)) {
                    violations.push(`${relativePath}:uses:${retired}`);
                }
            }
        }

        const publicAuthoringDaemon = readFileSync(
            join(examplesRoot, 'public-authoring', 'daemon.ts'),
            'utf8',
        );
        const publicAuthoringManifest = JSON.parse(readFileSync(
            join(examplesRoot, 'public-authoring', '.happier-plugin', 'plugin.json'),
            'utf8',
        )) as ParsedPluginManifestV2;
        const publicAuthoringBuild = readFileSync(
            join(examplesRoot, 'public-authoring', 'pluginUiBuild.ts'),
            'utf8',
        );
        const publicAuthoringVoice = readFileSync(
            join(examplesRoot, 'public-authoring', 'voiceProvider.ts'),
            'utf8',
        );
        const publicAuthoringIndex = readFileSync(
            join(examplesRoot, 'public-authoring', 'index.ts'),
            'utf8',
        );
        expect(publicAuthoringDaemon).toContain("from '@happier-dev/plugin-sdk/agent-runtime'");
        expect(publicAuthoringDaemon).toContain("from '@happier-dev/plugin-sdk'");
        expect(publicAuthoringManifest.entrypoints).toEqual({ daemon: './daemon.js' });
        expect(publicAuthoringManifest.activation?.events ?? []).not.toContainEqual({ kind: 'startup' });
        expect(publicAuthoringBuild).toContain("from '@happier-dev/plugin-sdk/ui/build'");
        expect(publicAuthoringDaemon).toContain("api.actions.register('review-summary'");
        expect(publicAuthoringDaemon).toContain("context.ui.status.set('review-summary'");
        expect(publicAuthoringDaemon).toContain("api.hooks.register('session-spawned'");
        expect(publicAuthoringDaemon).toContain("api.agents.register('review-agent'");
        expect(publicAuthoringVoice).toContain("api.voiceProviders.register('credentialed-browser'");
        expect(publicAuthoringVoice).toContain('PluginVoiceProviderSettingsOperations');
        expect(publicAuthoringVoice).toContain("operationId: 'client-auth'");
        expect(publicAuthoringVoice).toContain("operationId: 'list-catalog'");
        expect(publicAuthoringVoice).not.toContain("ui.executeAction('mint-voice-session'");
        expect(publicAuthoringVoice).not.toContain("ui.executeAction('list-voice-catalog'");
        expect(publicAuthoringDaemon).not.toContain("api.actions.register('mint-voice-session'");
        expect(publicAuthoringDaemon).not.toContain("api.actions.register('list-voice-catalog'");
        expect(publicAuthoringDaemon).not.toContain('executeVoiceAccountOperation');
        expect(publicAuthoringDaemon).not.toContain("kind: 'voiceAccountOperation'");
        expect(publicAuthoringManifest.contributes.actions.map(({ id }) => id)).toEqual([
            'review-summary',
        ]);
        expect(publicAuthoringIndex).toContain('activateAccountMediatedBrowserVoiceProvider');
        expect(publicAuthoringIndex).not.toContain('activateCredentiallessBrowserVoiceProvider');
        expect(publicAuthoringVoice).toContain("from '@happier-dev/plugin-sdk'");
        expect(publicAuthoringDaemon).not.toContain('api.lifecycle.onWillDeactivate');
        expect(publicAuthoringDaemon).not.toMatch(/\b(?:PluginContext|registerAction|registerHook|registerAgentRuntime|onDispose)\b/u);
        expect(violations).toEqual([]);
    });

    it('executes declared Voice account operations through the provider runtime owner', async () => {
        const voiceModule = await import(pathToFileURL(
            join(examplesRoot, 'public-authoring', 'voiceProvider.ts'),
        ).href) as Readonly<{
            activate(api: Pick<PluginApi, 'voiceProviders'>): void;
        }>;
        const captured: { runtime: PluginVoiceProviderRuntimeRegistration | null } = {
            runtime: null,
        };
        voiceModule.activate({
            voiceProviders: {
                register(id, runtime) {
                    expect(id).toBe('credentialed-browser');
                    captured.runtime = runtime;
                },
                registerSpeech(id): never {
                    throw new Error(`unexpected_voice_speech_provider_registration:${id}`);
                },
            },
        });
        if (!captured.runtime) {
            throw new Error('credentialed_browser_voice_provider_not_registered');
        }
        const runtime = captured.runtime;
        const signal = new AbortController().signal;
        const accountOperationRequest = vi.fn(async (
            input: Parameters<PluginVoiceAccountOperationService['request']>[0],
        ) => {
            const body = input.operationId === 'client-auth'
                ? {
                    sessionToken: 'short-lived-client-token',
                    expiresAtMs: 4_000_000_000_000,
                }
                : input.operationId === 'list-catalog'
                    ? {
                        voices: [{
                            voiceId: 'synthetic-voice',
                            displayName: 'Synthetic Voice',
                            locale: 'en',
                        }],
                    }
                    : null;
            if (!body) {
                throw new Error(`unexpected_voice_account_operation:${input.operationId}`);
            }
            return {
                status: 200,
                finalUrl: `https://voice.example.test/v1/${
                    input.operationId === 'client-auth' ? 'session' : 'catalog'
                }`,
                headers: { 'content-type': 'application/json' },
                body: new TextEncoder().encode(JSON.stringify(body)),
            };
        });
        const accountOperations: PluginVoiceAccountOperationService = {
            request: accountOperationRequest,
        };

        const preparation = await runtime.protocol.prepare({
            controlSessionId: 'public-authoring-voice',
            attemptId: 1,
            reason: 'initial',
            request: null,
            platform: 'web',
            providerConfig: {},
            accountOperations,
            providerConversation: null,
            hostedConversation: null,
            signal,
        });
        expect(preparation.kind).toBe('prepared');
        if (preparation.kind !== 'prepared') {
            throw new Error(`unexpected_voice_preparation:${preparation.kind}`);
        }
        expect(accountOperationRequest).toHaveBeenNthCalledWith(1, {
            operationId: 'client-auth',
            parameters: {},
            signal,
        });
        expect(preparation.session.safeMetadata).toEqual({});
        expect(JSON.stringify(preparation.session.safeMetadata)).not.toContain(
            'short-lived-client-token',
        );

        const settingsOperations = runtime.settingsOperations;
        if (!settingsOperations?.listCatalog) {
            throw new Error('credentialed_browser_voice_catalog_not_registered');
        }
        await expect(settingsOperations.listCatalog({
            catalog: 'voices',
            providerConfig: {},
            accountOperations,
            signal,
        })).resolves.toEqual([{
            id: 'synthetic-voice',
            name: 'Synthetic Voice',
            metadata: { locale: 'en' },
        }]);
        expect(accountOperationRequest).toHaveBeenNthCalledWith(2, {
            operationId: 'list-catalog',
            parameters: {},
            signal,
        });

        const executeAction = vi.fn(async (): Promise<never> => {
            throw new Error('ui_execute_action_must_not_own_voice_account_operations');
        });
        const unexpectedUiCall = (method: string): never => {
            throw new Error(`unexpected_ui_call:${method}`);
        };
        const ui: PluginUiHostApi = {
            version: () => ({ apiVersion: '1', wireVersion: 1, methods: ['executeAction'] }),
            context: async () => unexpectedUiCall('context'),
            watchContext: () => unexpectedUiCall('watchContext'),
            executeAction,
            readResource: async () => unexpectedUiCall('readResource'),
            watchResource: () => unexpectedUiCall('watchResource'),
            openSurface: async () => unexpectedUiCall('openSurface'),
            diagnostic: () => unexpectedUiCall('diagnostic'),
            readClipboard: async () => unexpectedUiCall('readClipboard'),
            writeClipboard: async () => unexpectedUiCall('writeClipboard'),
            openExternalLink: async () => unexpectedUiCall('openExternalLink'),
        };
        const unexpectedMediaCall = (): never => {
            throw new Error('unexpected_voice_media_call');
        };
        const connection = await runtime.createConnection({
            session: preparation.session,
            attemptId: 1,
            mic: {
                ensureActive: async () => undefined,
                setMuted: () => undefined,
                isMuted: () => false,
                teardown: async () => undefined,
                getStream: () => null,
            },
            interruption: { duckGain: 0.25, retainedOutputMaxMs: 500 },
            levels: { onOutputLevel: () => undefined },
            media: {
                createSdkHandleConnection: unexpectedMediaCall,
                createWebRtcConnection: unexpectedMediaCall,
                createPcmConnection: unexpectedMediaCall,
            },
            tools: [],
            ui,
            signal,
            execution: { kind: 'direct_media' },
        });
        await connection.connect(signal);
        expect(executeAction).not.toHaveBeenCalled();
        await connection.close({ code: 'user_stop' });
    });

    it('ships the required installable example plugin packages', () => {
        const missing: string[] = [];
        for (const exampleName of requiredExamples) {
            const root = join(examplesRoot, exampleName);
            const files = [
                'README.md',
                '.happier-plugin/plugin.json',
                'src/index.ts',
            ];
            for (const file of files) {
                try {
                    readFileSync(join(root, file), 'utf8');
                } catch {
                    missing.push(`${exampleName}/${file}`);
                }
            }
        }

        expect(missing).toEqual([]);
        const examplesTypeScriptConfig = JSON.parse(
            readFileSync(join(examplesRoot, 'tsconfig.json'), 'utf8'),
        ) as {
            compilerOptions?: { jsx?: string; paths?: Readonly<Record<string, readonly string[]>> };
            include?: readonly string[];
        };
        expect(examplesTypeScriptConfig.compilerOptions?.paths).toBeUndefined();
        expect(examplesTypeScriptConfig.compilerOptions?.jsx).toBe('preserve');
        expect(examplesTypeScriptConfig.include).toContain('**/*.tsx');
    });

    it('parses every example manifest with the protocol schema', () => {
        for (const exampleName of requiredExamples) {
            expect(readExampleManifest(exampleName).id).toMatch(/^examples\./u);
        }
    });

    it('parses the public authoring cold JSON manifest with the protocol schema', () => {
        const manifest = JSON.parse(readFileSync(
            join(examplesRoot, 'public-authoring', '.happier-plugin', 'plugin.json'),
            'utf8',
        )) as unknown;
        const ingested = ingestPluginManifestV2(manifest);

        expect(
            ingested.ok,
            ingested.ok ? undefined : JSON.stringify(ingested.diagnostics),
        ).toBe(true);
        if (ingested.ok) {
            expect(ingested.manifest.contributes.voiceModelPacks).toHaveLength(1);
            expect(ingested.manifest.contributes.voiceProviders).toEqual([
                expect.objectContaining({
                    id: 'credentialed-browser',
                    platforms: ['web'],
                    capabilities: expect.objectContaining({
                        readiness: { requirements: ['credential'] },
                    }),
                    accountMediation: {
                        credentialSlots: [{ id: 'api_key', scope: 'account' }],
                        operations: [
                            expect.objectContaining({
                                id: 'client-auth',
                                purpose: 'voice.client-auth',
                                credentialSlotId: 'api_key',
                                request: expect.objectContaining({ method: 'POST' }),
                            }),
                            expect.objectContaining({
                                id: 'list-catalog',
                                purpose: 'voice.catalog',
                                credentialSlotId: 'api_key',
                                request: expect.objectContaining({ method: 'GET' }),
                            }),
                        ],
                    },
                }),
            ]);
            expect(ingested.manifest.contributes.settings).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'preferences', scope: 'local' }),
            ]));
            expect(ingested.manifest.hostAccess.required).toContainEqual(expect.objectContaining({
                id: 'model-pack-downloads',
                capability: 'network',
            }));
            expect(ingested.manifest.hostAccess.required).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'voice-client-auth',
                    capability: 'network',
                    scope: expect.objectContaining({ methods: ['POST'] }),
                }),
                expect.objectContaining({
                    id: 'voice-catalog',
                    capability: 'network',
                    scope: expect.objectContaining({ methods: ['GET'] }),
                }),
            ]));
            expect(ingested.manifest.contributes.actions).toEqual([
                expect.objectContaining({
                    id: 'review-summary',
                    surfaces: ['cli', 'agent'],
                    scopes: ['transcript'],
                }),
            ]);
            expect(ingested.manifest.contributes.tools).toContainEqual(expect.objectContaining({
                id: 'review-summary-tool',
                action: 'review-summary',
            }));
            expect(ingested.manifest.contributes.commands).toContainEqual(expect.objectContaining({
                id: 'review-summary-command',
                action: 'review-summary',
            }));
        }
    });

    it('keeps executable source modules from becoming a second manifest owner', async () => {
        for (const exampleName of requiredExamples) {
            const module = await import(pathToFileURL(
                join(examplesRoot, exampleName, 'src/index.ts'),
            ).href) as { manifest?: unknown };
            expect(module).not.toHaveProperty('manifest');
        }
    });

    it('declares distinct strict public UI scenarios without authored artifact rows', async () => {
        const kindsByExample = new Map<string, readonly string[]>();
        for (const exampleName of requiredExamples) {
            const manifest = readExampleManifest(exampleName);
            kindsByExample.set(exampleName, manifest.contributes.ui.renderers.map((renderer) => renderer.kind));
            expect(manifest).not.toHaveProperty('uses');
            expect(manifest).not.toHaveProperty('permissions');
            expect(manifest.contributes).not.toHaveProperty('uiArtifacts');
        }
        expect(kindsByExample.get('descriptor-only')).toEqual(['declarative']);
        expect(kindsByExample.get('hosted-web')).toEqual(['hostedWeb', 'declarative']);
        expect(kindsByExample.get('react-native-installed')).toEqual(['reactNative', 'declarative']);
        expect(kindsByExample.get('react-native-dev-hot-reload')).toEqual(['reactNative', 'declarative']);
        expect(kindsByExample.get('multi-mode-fallback')).toEqual(['reactNative', 'hostedWeb', 'declarative']);
        const developmentModule = await import(pathToFileURL(join(
            examplesRoot,
            'react-native-dev-hot-reload',
            'src/index.ts',
        )).href) as { activate?: unknown };
        expect(developmentModule.activate).toBeTypeOf('function');
    });

    it('declares UI build inputs through the stable public build subpath', async () => {
        for (const exampleName of requiredExamples.filter((name) => name !== 'descriptor-only')) {
            const buildPath = join(examplesRoot, exampleName, 'pluginUiBuild.ts');
            expect(readFileSync(buildPath, 'utf8')).toContain("from '@happier-dev/plugin-sdk/ui/build'");
            const module = await import(pathToFileURL(buildPath).href) as {
                pluginUiBuildConfig?: {
                    outDir?: string;
                    targets?: readonly {
                        entry: string;
                        kind: 'reactNative' | 'hostedWeb';
                        rendererId: string;
                    }[];
                };
            };
            expect(module.pluginUiBuildConfig?.targets?.length).toBeGreaterThan(0);
            expect(module.pluginUiBuildConfig?.outDir).toMatch(/^dist\//u);
            expect(module.pluginUiBuildConfig).not.toHaveProperty('surfaces');
            expect(module.pluginUiBuildConfig).not.toHaveProperty('runBundler');
            const manifest = readExampleManifest(exampleName);
            const executableRenderers = manifest.contributes.ui.renderers
                .filter((renderer) => renderer.kind !== 'declarative')
                .map((renderer) => ({ rendererId: renderer.id, kind: renderer.kind }));
            expect(module.pluginUiBuildConfig?.targets?.map(({ rendererId, kind }) => ({ rendererId, kind })))
                .toEqual(executableRenderers);
            for (const target of module.pluginUiBuildConfig?.targets ?? []) {
                const sourceModule = await import(
                    pathToFileURL(join(examplesRoot, exampleName, target.entry)).href
                ) as { connectHostedWebPanel?: unknown; renderSurface?: unknown };
                if (target.kind === 'reactNative') {
                    expect(sourceModule.renderSurface, `${exampleName}:${target.rendererId}`).toBeTypeOf('function');
                } else {
                    expect(sourceModule.connectHostedWebPanel, `${exampleName}:${target.rendererId}`).toBeTypeOf('function');
                }
            }
        }

        const publicAuthoringBuild = await import(pathToFileURL(join(
            examplesRoot,
            'public-authoring',
            'pluginUiBuild.ts',
        )).href) as { pluginUiBuildConfig?: { outDir?: string } };
        expect(publicAuthoringBuild.pluginUiBuildConfig?.outDir).toBe('dist/ui');
    });

    it('typechecks copied installable and public-authoring examples through package exports only', () => {
        expect(shouldCopyExamplePath('/tmp/examples/hosted-web/dist/ui/index.js')).toBe(false);
        expect(shouldCopyExamplePath('C:\\tmp\\examples\\hosted-web\\dist\\ui\\index.js')).toBe(false);
        expect(shouldCopyExamplePath('/tmp/examples/hosted-web/node_modules/pkg/index.js')).toBe(false);
        expect(shouldCopyExamplePath('C:\\tmp\\examples\\hosted-web\\node_modules\\pkg\\index.js')).toBe(false);

        const copiedRoot = copyExamplesOutsideWorkspace();
        try {
            const expectedTypeScriptFiles = [
                ...requiredExamples.flatMap((exampleName) => [
                    join(copiedRoot, exampleName, 'src/index.ts'),
                    ...(exampleName === 'descriptor-only'
                        ? []
                        : [join(
                            copiedRoot,
                            exampleName,
                            'ui',
                            exampleName === 'hosted-web'
                                ? 'panel.web.tsx'
                                : exampleName === 'multi-mode-fallback'
                                    ? 'panel.tsx'
                                    : 'panel.native.tsx',
                        )]),
                ]),
                ...['daemon.ts', 'index.ts', 'pluginUiBuild.ts', 'voiceProvider.ts']
                    .map((fileName) => join(copiedRoot, 'public-authoring', fileName)),
            ];
            const configFile = {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    lib: ['ES2022', 'DOM'],
                    strict: true,
                    skipLibCheck: true,
                    outDir: '.compiled-example-output',
                    jsx: 'preserve',
                },
                include: ['**/*.ts', '**/*.tsx'],
                exclude: ['node_modules'],
            };
            const configPath = join(copiedRoot, 'tsconfig.json');
            writeFileSync(configPath, `${JSON.stringify(configFile, null, 2)}\n`, 'utf8');
            for (const sourcePath of expectedTypeScriptFiles) {
                expect(existsSync(sourcePath), sourcePath).toBe(true);
            }
            const typecheck = spawnSync(process.execPath, [
                join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
                '-p',
                configPath,
            ], {
                cwd: copiedRoot,
                encoding: 'utf8',
            });
            expect(
                typecheck.status,
                [typecheck.stdout, typecheck.stderr].filter(Boolean).join('\n'),
            ).toBe(0);
            const emitRoot = join(copiedRoot, '.compiled-example-output');
            expect(existsSync(emitRoot)).toBe(true);
            for (const sourcePath of expectedTypeScriptFiles) {
                const emittedRelativePath = relative(copiedRoot, sourcePath)
                    .replace(/\.tsx$/u, '.jsx')
                    .replace(/\.ts$/u, '.js');
                expect(existsSync(join(emitRoot, emittedRelativePath)), emittedRelativePath).toBe(true);
            }
        } finally {
            rmSync(copiedRoot, { recursive: true, force: true });
        }
    });
});

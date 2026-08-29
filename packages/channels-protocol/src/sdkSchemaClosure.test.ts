import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runBoundedChildProcess } from '../test/boundedChildProcess.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const typeScriptCliPath = join(repositoryRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');

async function runTypeScript(cwd: string, args: readonly string[]): Promise<void> {
    await runBoundedChildProcess({
        label: 'Channels SDK schema closure TypeScript compiler',
        command: process.execPath,
        args: [typeScriptCliPath, ...args],
        cwd,
        timeoutMs: 30_000,
        maxOutputBytes: 1_000_000,
    });
}

async function hasPath(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function declarationSources(directory: string): Promise<readonly string[]> {
    const entries = await readdir(directory, { recursive: true });
    return Promise.all(entries
        .filter((entry) => entry.endsWith('.d.ts'))
        .map((entry) => readFile(join(directory, entry), 'utf8')));
}

async function writeSourceDeclarationConfig(declarationDirectory: string): Promise<string> {
    const configPath = join(declarationDirectory, 'tsconfig.source-declaration.json');
    const pluginSdkContributionsSource = relative(
        declarationDirectory,
        join(repositoryRoot, 'packages', 'plugin-sdk', 'src', 'contributions', 'index.ts'),
    );
    const pluginSdkProtocolSource = relative(
        declarationDirectory,
        join(repositoryRoot, 'packages', 'plugin-sdk', 'src', 'protocol', 'index.ts'),
    );
    const repositoryTypeRoots = relative(
        declarationDirectory,
        join(repositoryRoot, 'node_modules', '@types'),
    );
    await writeFile(configPath, `${JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            lib: ['ES2022', 'DOM'],
            types: ['node'],
            typeRoots: [repositoryTypeRoots],
            rootDir: repositoryRoot,
            outDir: declarationDirectory,
            declaration: true,
            declarationMap: false,
            stripInternal: true,
            sourceMap: false,
            strict: true,
            skipLibCheck: true,
            paths: {
                '@happier-dev/plugin-sdk/contributions': [
                    pluginSdkContributionsSource,
                ],
                '@happier-dev/plugin-sdk/protocol': [
                    pluginSdkProtocolSource,
                ],
            },
        },
        files: [join(packageRoot, 'src', 'v1', 'provider', 'contribution.ts')],
    }, null, 2)}\n`, 'utf8');
    return configPath;
}

async function emitPackageDeclarations(declarationDirectory: string): Promise<void> {
    await runTypeScript(packageRoot, [
        '-p',
        'tsconfig.json',
        '--outDir',
        declarationDirectory,
        '--tsBuildInfoFile',
        join(declarationDirectory, '.tsbuildinfo'),
        '--incremental',
        'false',
        '--declarationMap',
        'false',
        '--emitDeclarationOnly',
    ]);
}

async function installPublicSdkPublicBoundaryStub(consumerRoot: string): Promise<void> {
    const sdkRoot = join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    await mkdir(sdkRoot, { recursive: true });
    await Promise.all([
        writeFile(join(sdkRoot, 'package.json'), `${JSON.stringify({
            name: '@happier-dev/plugin-sdk',
            private: true,
            type: 'module',
            exports: {
                './protocol': {
                    types: './protocol.d.ts',
                    default: './protocol.js',
                },
                './contributions': {
                    types: './contributions.d.ts',
                    default: './contributions.js',
                },
                './manifest': {
                    types: './manifest.d.ts',
                    default: './manifest.js',
                },
            },
        }, null, 2)}\n`, 'utf8'),
        writeFile(join(sdkRoot, 'protocol.js'), 'export {};\n', 'utf8'),
        writeFile(join(sdkRoot, 'contributions.js'), 'export {};\n', 'utf8'),
        // This is the declared external SDK boundary, deliberately limited to
        // the public type names Channels emits. Using the workspace SDK here
        // would allow its own private Protocol dependency to hide a leak.
        writeFile(join(sdkRoot, 'protocol.d.ts'), `
export type ProtocolJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ProtocolJsonValue[]
    | { readonly [key: string]: ProtocolJsonValue };
export type PluginJsonSchema = Readonly<Record<string, ProtocolJsonValue>>;
export type ProtocolValidationIssue = Readonly<{
    path: readonly (string | number)[];
    code: string;
}>;
export class ProtocolValidationError extends Error {
    readonly issues: readonly ProtocolValidationIssue[];
}
export interface ProtocolComposableSchema<TInput = ProtocolJsonValue, TOutput = TInput> {
    readonly jsonSchema: PluginJsonSchema;
    parse(value: unknown): TOutput;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: TOutput }>
        | Readonly<{ success: false; error: ProtocolValidationError }>;
    optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined>;
    nullable(): ProtocolComposableSchema<TInput | null, TOutput | null>;
}
`, 'utf8'),
        writeFile(join(sdkRoot, 'contributions.d.ts'), `
export type ContributionPointAuthorDefinition<TProtocols extends readonly unknown[]> = Readonly<{
    readonly protocols: readonly unknown[];
    readonly __protocols?: TProtocols;
}>;
export interface ContributionProtocol<
    TOperations = unknown,
    TSurfaces = unknown,
    TDescriptorSchema = unknown,
    TProtocolId extends string = string,
    TProtocolVersion extends number = number,
> {
    readonly id: TProtocolId;
    readonly version: TProtocolVersion;
    readonly operations: TOperations;
    readonly surfaces: TSurfaces;
    readonly descriptor?: TDescriptorSchema;
}
export type PluginTargetedContributionSelectionV1 = Readonly<{
    target: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
    }>;
    point: Readonly<{
        pointId: string;
        protocol: Readonly<{
            id: string;
            version: number;
        }>;
    }>;
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
}>;
export type ContributionActionSurface = 'cli' | 'mcp' | 'agent' | 'ui' | 'plugin' | 'voice';
export type ContributionActionDangerLevel =
    | 'safe'
    | 'writesLocal'
    | 'writesRemote'
    | 'externalSideEffect'
    | 'destructive';
export type ContributionSurfacePresentation = 'content' | 'fill';
`, 'utf8'),
        // `/testing/v1` deliberately exposes the canonical parsed manifest
        // alongside its selected Channels contribution. It is a public SDK
        // peer entrypoint, not a route back to private Protocol types.
        writeFile(join(sdkRoot, 'manifest.js'), 'export {};\n', 'utf8'),
        writeFile(join(sdkRoot, 'manifest.d.ts'), `
export type ParsedPluginManifest = Readonly<Record<string, unknown>>;
export type PluginContributionIdentity = {
    pluginId: string;
    localId: string;
};
`, 'utf8'),
    ]);
}

async function installPackedChannelsProtocol(
    consumerRoot: string,
    declarationDirectory = join(packageRoot, 'dist'),
): Promise<void> {
    const installedPackageRoot = join(
        consumerRoot,
        'node_modules',
        '@happier-dev',
        'channels-protocol',
    );
    await mkdir(installedPackageRoot, { recursive: true });
    await Promise.all([
        cp(join(packageRoot, 'package.json'), join(installedPackageRoot, 'package.json')),
        cp(declarationDirectory, join(installedPackageRoot, 'dist'), { recursive: true }),
    ]);
}

async function installIsolatedConsumer(
    consumerRoot: string,
    declarationDirectory?: string,
): Promise<void> {
    await mkdir(join(consumerRoot, 'src'), { recursive: true });
    await Promise.all([
        installPackedChannelsProtocol(consumerRoot, declarationDirectory),
        installPublicSdkPublicBoundaryStub(consumerRoot),
        writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
            name: 'channels-protocol-declaration-closure-consumer',
            private: true,
            type: 'module',
            dependencies: {
                '@happier-dev/channels-protocol': '0.0.0',
                '@happier-dev/plugin-sdk': '0.0.0',
            },
        }, null, 2)}\n`, 'utf8'),
        writeFile(join(consumerRoot, 'tsconfig.json'), `${JSON.stringify({
            compilerOptions: {
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                strict: true,
                skipLibCheck: false,
                noEmit: true,
                types: [],
            },
            include: ['src/**/*.ts'],
        }, null, 2)}\n`, 'utf8'),
        writeFile(join(consumerRoot, 'src', 'consumer.ts'), `
import type {
    ConversationJsonValueV1,
    ConversationProviderSetupResultV1,
} from '@happier-dev/channels-protocol/v1';

type RootContributionPoint = typeof import('@happier-dev/channels-protocol')
    .ConversationProvidersContributionPointV1;
type V1ContributionProtocol = typeof import('@happier-dev/channels-protocol/v1')
    .ConversationProvidersContributionProtocolV1;
type V1ResolutionCandidateOrder = typeof import('@happier-dev/channels-protocol/v1')
    .hasCanonicalConversationResolutionCandidateOrderV1;
type V1FixtureFactory = typeof import('@happier-dev/channels-protocol/testing/v1')
    .createConversationProviderSetupResultV1Fixture;
type V1ProviderContributionAssertion = typeof import('@happier-dev/channels-protocol/testing/v1')
    .assertConversationProviderContributionV1;
type V1ProviderContributionCheck = typeof import('@happier-dev/channels-protocol/testing/v1')
    .checkConversationProviderContributionV1;
type V1ProviderContributionConformance = import('@happier-dev/channels-protocol/testing/v1')
    .ConversationProviderContributionConformanceResultV1;

const json: ConversationJsonValueV1 = {
    consumer: ['only declared public dependencies'],
};

export type ChannelsProtocolExternalConsumerProof = readonly [
    typeof json,
    ConversationProviderSetupResultV1,
    RootContributionPoint,
    V1ContributionProtocol,
    V1ResolutionCandidateOrder,
    V1FixtureFactory,
    V1ProviderContributionAssertion,
    V1ProviderContributionCheck,
    V1ProviderContributionConformance,
];
`, 'utf8'),
    ]);
}

describe('Channels SDK schema closure', () => {
    it('models only the direct composable protocol and contribution boundaries for isolated consumers', async () => {
        const consumerRoot = await mkdtemp(join(tmpdir(), 'happier-channels-protocol-sdk-boundary-'));
        try {
            await installPublicSdkPublicBoundaryStub(consumerRoot);
            const declaration = await readFile(join(
                consumerRoot,
                'node_modules',
                '@happier-dev',
                'plugin-sdk',
                'protocol.d.ts',
            ), 'utf8');

            expect(declaration).toContain('export interface ProtocolComposableSchema<');
            expect(declaration).toContain('optional(): ProtocolComposableSchema<');
            expect(declaration).toContain('nullable(): ProtocolComposableSchema<');
            for (const retired of [
                'adoptProtocolSchema',
                'defineProtocolSchema',
                'ProtocolAuthoringSchema',
                'ProtocolJsonValueSchema',
                'PublicProtocolSchema',
                '~standard',
            ]) {
                expect(declaration).not.toContain(retired);
            }
        } finally {
            await rm(consumerRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    });

    it('emits a declaration-safe inferred contribution-point protocol tuple', async () => {
        const declarationDirectory = await mkdtemp(join(
            tmpdir(),
            'happier-channels-protocol-source-declaration-',
        ));
        try {
            const contributionSource = await readFile(
                join(packageRoot, 'src', 'v1', 'provider', 'contribution.ts'),
                'utf8',
            );
            const sourceConfigPath = await writeSourceDeclarationConfig(declarationDirectory);
            await runTypeScript(repositoryRoot, ['-p', sourceConfigPath]);

            expect(contributionSource).not.toContain('ContributionPointAuthorDefinition');

            const contributionDeclaration = await readFile(
                join(
                    declarationDirectory,
                    'packages',
                    'channels-protocol',
                    'src',
                    'v1',
                    'provider',
                    'contribution.d.ts',
                ),
                'utf8',
            );
            expect(contributionDeclaration).toContain('ConversationProvidersContributionPointV1: Readonly<{');
            expect(contributionDeclaration).toContain('readonly __protocols?: readonly [');
            expect(contributionDeclaration).not.toContain('targetedContributionPointEvidence');
        } finally {
            await rm(declarationDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    }, 60_000);

    it('keeps V1 schema composition validator-neutral on public SDK entrypoints', async () => {
        const v1Directory = new URL('./v1/', import.meta.url);
        const v1Entries = await readdir(v1Directory, { recursive: true });
        const v1Sources = await Promise.all(v1Entries
            .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
            .map((entry) => readFile(new URL(entry, v1Directory), 'utf8')));
        const packageJsonSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
        const packageJson = JSON.parse(packageJsonSource) as Readonly<{
            dependencies?: Readonly<Record<string, string>>;
            devDependencies?: Readonly<Record<string, string>>;
            optionalDependencies?: Readonly<Record<string, string>>;
            peerDependencies?: Readonly<Record<string, string>>;
        }>;

        expect(v1Sources).not.toHaveLength(0);
        for (const source of v1Sources) {
            expect(source).not.toMatch(/from\s+['"]@happier-dev\/protocol(?:\/[^'"]*)?['"]/u);
            expect(source).not.toMatch(/from\s+['"]zod['"]/u);
            expect(source).not.toContain('_zod');
            expect(source).not.toContain('ZodSchema');
            expect(source).not.toContain('requireZodIdentitySchema');
            expect(source).not.toContain('protocolAuthoringZod');
            expect(source).not.toMatch(/\bRegExp\b/u);
        }
        expect(packageJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();
        expect(packageJson.devDependencies?.['@happier-dev/protocol']).toBeUndefined();
        expect(packageJson.optionalDependencies?.['@happier-dev/protocol']).toBeUndefined();
        expect(packageJson.peerDependencies?.['@happier-dev/protocol']).toBeUndefined();
        expect(packageJson.dependencies?.zod).toBeUndefined();
        expect(packageJson.devDependencies?.zod).toBeUndefined();
        expect(packageJson.optionalDependencies?.zod).toBeUndefined();
        expect(packageJson.peerDependencies?.zod).toBeUndefined();
    });

    it('keeps Channels production code on public SDK and Channels-protocol imports', async () => {
        const channelsRoot = new URL('../../plugins/channels/', import.meta.url);
        const channelsSourceDirectory = new URL('./src/', channelsRoot);
        const sourceEntries = await readdir(channelsSourceDirectory, { recursive: true });
        const productionSources = await Promise.all(sourceEntries
            .filter((entry) => (
                (entry.endsWith('.ts') || entry.endsWith('.tsx'))
                && !entry.endsWith('.test.ts')
                && !entry.endsWith('.test.tsx')
            ))
            .map((entry) => readFile(new URL(entry, channelsSourceDirectory), 'utf8')));
        const packageJsonSource = await readFile(new URL('./package.json', channelsRoot), 'utf8');
        const packageJson = JSON.parse(packageJsonSource) as Readonly<{
            dependencies?: Readonly<Record<string, string>>;
            devDependencies?: Readonly<Record<string, string>>;
            optionalDependencies?: Readonly<Record<string, string>>;
            peerDependencies?: Readonly<Record<string, string>>;
        }>;

        expect(productionSources).not.toHaveLength(0);
        for (const source of productionSources) {
            expect(source).not.toContain('@happier-dev/protocol');
        }
        expect(packageJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();
        expect(packageJson.devDependencies?.['@happier-dev/protocol']).toBeUndefined();
        expect(packageJson.optionalDependencies?.['@happier-dev/protocol']).toBeUndefined();
        expect(packageJson.peerDependencies?.['@happier-dev/protocol']).toBeUndefined();
    });

    it('emits source declarations consumable with only its declared public dependencies', async () => {
        const declarationDirectory = await mkdtemp(join(
            tmpdir(),
            'happier-channels-protocol-package-declaration-',
        ));
        const isolationRoot = await mkdtemp(join(tmpdir(), 'happier-channels-protocol-source-closure-'));
        try {
            await emitPackageDeclarations(declarationDirectory);

            const consumerRoot = join(isolationRoot, 'consumer');
            await installIsolatedConsumer(consumerRoot, declarationDirectory);

            expect(
                await hasPath(join(consumerRoot, 'node_modules', '@happier-dev', 'protocol')),
                'the isolated consumer must not make the private Protocol package available',
            ).toBe(false);

            await runTypeScript(consumerRoot, ['-p', 'tsconfig.json']);

            const emittedDeclarations = await declarationSources(declarationDirectory);
            expect(emittedDeclarations).not.toHaveLength(0);
            for (const declaration of emittedDeclarations) {
                expect(declaration).not.toContain('@happier-dev/protocol');
                expect(declaration).not.toContain('ZodSchema');
                expect(declaration).not.toContain('_zod');
                expect(declaration).not.toMatch(/from\s+['"]zod['"]/u);
                expect(declaration).not.toContain('ProtocolJsonValueSchema');
            }
        } finally {
            await Promise.all([
                rm(declarationDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
                rm(isolationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
            ]);
        }
    }, 60_000);

    it('keeps built declarations consumable with only its declared public dependencies', async () => {
        const isolationRoot = await mkdtemp(join(tmpdir(), 'happier-channels-protocol-declaration-closure-'));
        try {
            const consumerRoot = join(isolationRoot, 'consumer');
            await installIsolatedConsumer(consumerRoot);

            expect(
                await hasPath(join(consumerRoot, 'node_modules', '@happier-dev', 'protocol')),
                'the isolated consumer must not make the private Protocol package available',
            ).toBe(false);

            await runTypeScript(consumerRoot, ['-p', 'tsconfig.json']);

            const emittedDeclarations = await declarationSources(join(packageRoot, 'dist'));
            expect(emittedDeclarations).not.toHaveLength(0);
            for (const declaration of emittedDeclarations) {
                expect(declaration).not.toContain('@happier-dev/protocol');
                expect(declaration).not.toContain('ZodSchema');
                expect(declaration).not.toContain('_zod');
                expect(declaration).not.toMatch(/from\s+['"]zod['"]/u);
                expect(declaration).not.toContain('ProtocolJsonValueSchema');
            }
        } finally {
            await rm(isolationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    }, 60_000);
});

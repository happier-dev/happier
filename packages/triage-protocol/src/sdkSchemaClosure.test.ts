import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const typeScriptCliPath = join(repositoryRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');

/**
 * The repository TypeScript CLI is a genuine process boundary. `execFile`'s own
 * deadline and output ceiling bound it, so this probe adds no second
 * child-process helper.
 */
async function runTypeScript(cwd: string, args: readonly string[]): Promise<void> {
    try {
        await execFileAsync(process.execPath, [typeScriptCliPath, ...args], {
            cwd,
            timeout: 120_000,
            maxBuffer: 4_000_000,
            windowsHide: true,
        });
    } catch (error) {
        const detail = error instanceof Error && 'stdout' in error
            ? `${String(Reflect.get(error, 'stdout'))}\n${String(Reflect.get(error, 'stderr'))}`
            : String(error);
        throw new Error(`Triage protocol declaration closure compile failed:\n${detail}`);
    }
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

/**
 * The declared external SDK boundary, deliberately limited to the public type
 * names Triage emits. Using the workspace SDK here would let its own private
 * Protocol dependency hide a leak.
 */
async function installPublicSdkPublicBoundaryStub(consumerRoot: string): Promise<void> {
    const sdkRoot = join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    await mkdir(sdkRoot, { recursive: true });
    const subpaths = ['protocol', 'contributions', 'manifest', 'connected-accounts', 'sessions'];
    await Promise.all([
        writeFile(join(sdkRoot, 'package.json'), `${JSON.stringify({
            name: '@happier-dev/plugin-sdk',
            private: true,
            type: 'module',
            exports: Object.fromEntries(subpaths.map((subpath) => [`./${subpath}`, {
                types: `./${subpath}.d.ts`,
                default: `./${subpath}.js`,
            }])),
        }, null, 2)}\n`, 'utf8'),
        ...subpaths.map((subpath) => writeFile(join(sdkRoot, `${subpath}.js`), 'export {};\n', 'utf8')),
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
export type ContributionPointAuthorDefinition<TProtocols extends readonly unknown[] = readonly unknown[]> = Readonly<{
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
export type ContributionActionSurface = 'cli' | 'mcp' | 'agent' | 'ui' | 'plugin';
export type ContributionActionDangerLevel =
    | 'safe'
    | 'writesLocal'
    | 'writesRemote'
    | 'externalSideEffect'
    | 'destructive';
export type ContributionSurfacePresentation = 'content' | 'fill';
`, 'utf8'),
        writeFile(join(sdkRoot, 'manifest.d.ts'), `
export type ParsedPluginManifest = Readonly<Record<string, unknown>>;
export type PluginContributionIdentity = {
    pluginId: string;
    localId: string;
};
`, 'utf8'),
        writeFile(join(sdkRoot, 'connected-accounts.d.ts'), `
export type QualifiedConnectedAccountRef = Readonly<{
    service: Readonly<{ pluginId: string; localId: string }>;
    accountId: string;
}>;
`, 'utf8'),
        writeFile(join(sdkRoot, 'sessions.d.ts'), `
export type SessionId = string;
`, 'utf8'),
    ]);
}

async function installIsolatedConsumer(
    consumerRoot: string,
    declarationDirectory: string,
): Promise<void> {
    const installedPackageRoot = join(
        consumerRoot,
        'node_modules',
        '@happier-dev',
        'triage-protocol',
    );
    await mkdir(join(consumerRoot, 'src'), { recursive: true });
    await mkdir(installedPackageRoot, { recursive: true });
    await Promise.all([
        cp(join(packageRoot, 'package.json'), join(installedPackageRoot, 'package.json')),
        cp(declarationDirectory, join(installedPackageRoot, 'dist'), { recursive: true }),
        installPublicSdkPublicBoundaryStub(consumerRoot),
        writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
            name: 'triage-protocol-declaration-closure-consumer',
            private: true,
            type: 'module',
            dependencies: {
                '@happier-dev/triage-protocol': '0.0.0',
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
    TriageEntryRefV1,
    TriageSourceObservationV1,
} from '@happier-dev/triage-protocol/v1';

type RootContributionPoint = typeof import('@happier-dev/triage-protocol')
    .TriageSourcesContributionPointV1;
type V1ContributionProtocol = typeof import('@happier-dev/triage-protocol/v1')
    .TriageSourcesContributionProtocolV1;
type V1AdministrationActionRef = typeof import('@happier-dev/triage-protocol/v1')
    .TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1;
type V1DetailInputSchema = typeof import('@happier-dev/triage-protocol/v1')
    .TriageDetailSurfaceInputV1Schema;
type V1FixtureFactory = typeof import('@happier-dev/triage-protocol/testing/v1')
    .createTriageSourceV1Fixture;
type V1ContributionAssertion = typeof import('@happier-dev/triage-protocol/testing/v1')
    .assertTriageSourceContributionV1;
type V1ContributionCheck = typeof import('@happier-dev/triage-protocol/testing/v1')
    .checkTriageSourceContributionV1;
type V1ConformanceResult = import('@happier-dev/triage-protocol/testing/v1')
    .TriageSourceConformanceResultV1;

declare const entryRef: TriageEntryRefV1;
declare const observation: TriageSourceObservationV1;

export type TriageProtocolExternalConsumerProof = readonly [
    typeof entryRef.source.pluginId,
    typeof observation.localRef.entryId,
    RootContributionPoint,
    V1ContributionProtocol,
    V1AdministrationActionRef,
    V1DetailInputSchema,
    V1FixtureFactory,
    V1ContributionAssertion,
    V1ContributionCheck,
    V1ConformanceResult,
];
`, 'utf8'),
    ]);
}

/**
 * Modification times under a directory, restricted to the extensions that can
 * change what the build emits.
 */
async function modificationTimes(directory: string): Promise<readonly number[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return Promise.all(entries
        .filter((entry) => entry.isFile() && /\.(?:ts|js|json)$/u.test(entry.name))
        .filter((entry) => !/\.(?:test|spec)\.ts$/u.test(entry.name))
        .map(async (entry) => (await stat(join(entry.parentPath, entry.name))).mtimeMs));
}

describe('Triage SDK schema closure', () => {
    it('reads declarations built from current source, not a stale dist', async () => {
        // This gate must read the built artifact: it decides what an installed
        // consumer sees. That makes a stale `dist` a silent pass, so freshness
        // is asserted rather than assumed. `vitest.globalSetup.mjs` builds the
        // package before any case runs; this case is what falsifies its absence.
        const [sourceTimes, emitTimes] = await Promise.all([
            modificationTimes(join(packageRoot, 'src')),
            modificationTimes(join(packageRoot, 'dist')),
        ]);
        expect(emitTimes.length).toBeGreaterThan(0);
        // The oldest emitted byte, not the newest: a partial rebuild that
        // refreshed one file would otherwise hide every file it skipped.
        expect(Math.min(...emitTimes)).toBeGreaterThanOrEqual(Math.max(...sourceTimes));
    });

    it('keeps built declarations consumable with only its declared public dependencies', async () => {
        const isolationRoot = await mkdtemp(join(tmpdir(), 'happier-triage-protocol-declaration-closure-'));
        try {
            const consumerRoot = join(isolationRoot, 'consumer');
            await installIsolatedConsumer(consumerRoot, join(packageRoot, 'dist'));

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
    }, 180_000);
});

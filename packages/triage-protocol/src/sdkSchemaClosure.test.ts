import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
 * The repository TypeScript CLI is a genuine process boundary. Its executor
 * owns admission and cancellation; a subprocess deadline must not expire while
 * the compiler is still queued for admission.
 */
async function runTypeScript(cwd: string, args: readonly string[]): Promise<void> {
    try {
        await execFileAsync(process.execPath, [typeScriptCliPath, ...args], {
            cwd,
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
    const subpaths = ['protocol', 'contributions', 'manifest', 'connected-accounts', 'sessions', 'scm'];
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
export type FileDownloadDestinationV1 = Readonly<{ destinationId: string }>;
// This boundary fixture names SDK's public transfer family. The transfer
// owner's own vectors validate its nested prepared/entry-tree representation.
export type FileDownloadResultV1 =
    | Readonly<{ success: false; status: 'failed' | 'cancelled' | 'unknown'; error: string; errorCode?: string }>
    | Readonly<{ success: true; status: 'accepted'; operationId: string; destinationId: string; prepared: ProtocolJsonValue; entryTree?: ProtocolJsonValue }>
    | Readonly<{ success: true; status: 'completed'; transferId: string; destinationId: string; name: string; sizeBytes: number; sha256: string }>;
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
// These are the external SDK declarations Triage now re-exports. No parser or
// identity grammar is supplied by this isolated declaration-boundary fixture.
export type TriageEntryRefV1 = Readonly<{
    source: Readonly<{ pluginId: string; localId: string }>;
    kindId: string;
    collisionScope: string;
    entryId: string;
}>;
export const TriageEntryRefV1Schema: ProtocolComposableSchema<TriageEntryRefV1>;
export const TriageEntryRefV1JsonSchema: PluginJsonSchema;
export const TriageIdentifierV1ProtocolSchema: ProtocolComposableSchema<string>;
export const TriageCollisionScopeV1ProtocolSchema: ProtocolComposableSchema<string>;
export const MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1: number;
export const MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1: number;
export const TRIAGE_SINGLE_LINE_STRING_PATTERN_V1: string;
export const TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1: string;
export function defineTriageSingleLineStringV1(maxUtf8Bytes: number): ProtocolComposableSchema<string>;
export function defineTriageCompositeIdentifierStringV1(maxUtf8Bytes: number): ProtocolComposableSchema<string>;
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
export type ContributionActionSurface = 'cli' | 'mcp' | 'agent' | 'ui' | 'plugin' | 'voice';
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
        writeFile(join(sdkRoot, 'scm.d.ts'), `
import type { ProtocolComposableSchema, ProtocolJsonValue } from './protocol.js';
export type ProtocolScmHostingProviderKind =
    | 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'custom' | 'unknown';
export type ScmHostingRepositoryIdentityV1<TKind extends ProtocolScmHostingProviderKind = ProtocolScmHostingProviderKind> = Readonly<{
    kind: TKind; deployment: string; repository: string;
}>;
export type ScmComparisonSource =
    | Readonly<{ kind: 'workingTree' }>
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'branch'; head: string; base: string }>
    | Readonly<{ kind: 'commit'; commit: string; parent?: string }>
    | Readonly<{ kind: 'turnCheckpoint'; sessionId?: string; turnId?: string; checkpointReceiptId?: string; evidenceMode?: 'checkpoint' | 'agent_reported' | 'reconciled' }>
    | Readonly<{ kind: 'pullRequest'; locator: Readonly<{
        providerId: string;
        repository: string;
        number: number;
        baseOid?: string;
        headOid?: string;
        sourceAction?: Readonly<{ action: Readonly<{ pluginId: string; localId: string }>; input?: ProtocolJsonValue }>;
    }> }>;
export declare const ScmComparisonSourceSchema: ProtocolComposableSchema<ScmComparisonSource>;
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
import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type {
    TriageEntryRefV1,
    TriageEntryStateV1,
    TriageSourceAccountBindingV1,
    TriageSourceObservationV1,
    TriageTaskWriteResultV1,
} from '@happier-dev/triage-protocol/v1';
import {
    TriageTaskCreateFieldsV1Schema,
    TriageTaskFieldsV1Schema,
    TriageTaskWriteResultV1Schema,
    triageTaskStatusCategoryV1,
} from '@happier-dev/triage-protocol/v1';
import {
    TriageTaskCreateFieldsV1Schema as RootCreateFields,
    TriageTaskFieldsV1Schema as RootFields,
    TriageTaskWriteResultV1Schema as RootWriteResult,
} from '@happier-dev/triage-protocol';
import {
    ForgeCiRunV1Schema,
    ForgeCiActionInputSchemasV1,
    ForgeCiActionResultSchemasV1,
    type ForgeCiActionInputByOperationV1,
    type ForgeCiActionResultByOperationV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import {
    ForgeReleaseV1Schema,
    ForgeReleaseActionInputSchemasV1,
    ForgeReleaseActionResultSchemasV1,
    type ForgeReleaseActionInputByOperationV1,
    type ForgeReleaseActionResultByOperationV1,
} from '@happier-dev/triage-protocol/releases/v1';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';

const ciVector = createForgeCiConformanceVectorsV1();
export const ciRun = ForgeCiRunV1Schema.parse(ciVector.github.run);
export const ciReadInput: ForgeCiActionInputByOperationV1['readRun'] =
    ForgeCiActionInputSchemasV1.readRun.parse({ repository: ciVector.github.repository, runId: ciRun.ref.runId });
export const ciReadResult: ForgeCiActionResultByOperationV1['readRun'] =
    ForgeCiActionResultSchemasV1.readRun.parse({ kind: 'value', value: ciRun });

export const release = ForgeReleaseV1Schema.parse(createForgeReleaseV1Fixture());
export const releaseReadInput: ForgeReleaseActionInputByOperationV1['readRelease'] =
    ForgeReleaseActionInputSchemasV1.readRelease.parse({ repository: release.repository, releaseId: release.releaseId });
export const releaseReadResult: ForgeReleaseActionResultByOperationV1['readRelease'] =
    ForgeReleaseActionResultSchemasV1.readRelease.parse({ kind: 'value', value: release });

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
const taskState: TriageEntryStateV1 = { presentation: 'active', stage: 'started' };
export const taskCategory = triageTaskStatusCategoryV1(taskState);
export const taskCreateFields = TriageTaskCreateFieldsV1Schema.parse({ title: 'Task' });
export const taskEditFields = TriageTaskFieldsV1Schema.parse({ body: 'Task details' });
export const taskResult: TriageTaskWriteResultV1 = TriageTaskWriteResultV1Schema.parse({ kind: 'uncertain' });
export const rootCreateFields: typeof TriageTaskCreateFieldsV1Schema = RootCreateFields;
export const rootFields: typeof TriageTaskFieldsV1Schema = RootFields;
export const rootWriteResult: typeof TriageTaskWriteResultV1Schema = RootWriteResult;

// The emitted account member must BE the canonical Connected Account ref, not a
// look-alike. Assignability both ways is what a restated local shape can lose:
// a copy that drops, renames, or widens a field still compiles at the schema
// binding (the composable schema is covariant in its parsed type) and would
// silently publish a different public contract.
declare const boundAccount: Extract<TriageSourceAccountBindingV1, { account: unknown }>['account'];
declare const canonicalAccount: QualifiedConnectedAccountRef;
export const emittedAccountIsCanonical: QualifiedConnectedAccountRef = boundAccount;
export const canonicalIsEmittedAccount: Extract<TriageSourceAccountBindingV1, { account: unknown }>['account'] = canonicalAccount;
declare const nativeService: Extract<TriageSourceAccountBindingV1, { source: 'native' }>['service'];
declare const canonicalService: PluginContributionIdentity;
export const emittedNativeServiceIsCanonical: PluginContributionIdentity = nativeService;
export const canonicalIsEmittedNativeService: Extract<TriageSourceAccountBindingV1, { source: 'native' }>['service'] = canonicalService;
export const accountDataBinding: Extract<TriageSourceAccountBindingV1, { source: 'accountData' }> = {
    purpose: 'task-data', source: 'accountData',
};

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

describe('Triage SDK schema closure', () => {
    it('keeps built declarations consumable with only its declared public dependencies', async () => {
        // Global setup uses the canonical incremental builder. Unchanged emitted
        // bytes can legitimately retain old timestamps; the isolated consumer
        // above instead requires the current public Task exports and state shape.
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
    }, 0);
});

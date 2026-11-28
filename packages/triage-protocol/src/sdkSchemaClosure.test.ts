import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { copyBuiltSdkArtifact, linkBuiltRuntimeDependencyClosure } from '../../plugin-sdk/src/test-support/sdkArtifactFixture.js';

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

/** Install the SDK's real public declarations with its private dependencies nested. */
async function installPublicSdkBoundary(consumerRoot: string): Promise<void> {
    const sdkRoot = join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    await mkdir(sdkRoot, { recursive: true });
    await copyBuiltSdkArtifact(sdkRoot);
    await Promise.all([
        linkBuiltRuntimeDependencyClosure(consumerRoot, join(repositoryRoot, 'packages', 'plugin-sdk')),
        linkBuiltRuntimeDependencyClosure(consumerRoot, packageRoot),
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
        installPublicSdkBoundary(consumerRoot),
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

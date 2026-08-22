import { existsSync } from 'node:fs';
import {
    access,
    cp,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    fixtureCommandTimeoutMs,
    runBoundedFixtureCommand,
} from './test-support/boundedFixtureCommand.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const pluginUiPackageRoot = join(repoRoot, 'packages', 'plugin-ui');
const fixtureRoot = join(packageRoot, 'fixtures', 'authoring-inference');
const externalTargetedPackageFixtureRoot = join(
    packageRoot,
    'fixtures',
    'external-targeted-packages',
);
const externalTargetedRuntimeProofPath = join(
    externalTargetedPackageFixtureRoot,
    'runtime-proof.mjs',
);
const externalTargetedSourceTypecheckConfigPath = join(
    externalTargetedPackageFixtureRoot,
    'tsconfig.source.json',
);
const externalAgentRuntimeSourceTypecheckConfigPath = join(
    externalTargetedPackageFixtureRoot,
    'tsconfig.agent-runtime.source.json',
);
const builtAuthorDeclarationRoots = [
    'index.d.ts',
    'actions/index.d.ts',
    'definePlugin.d.ts',
    'manifest.d.ts',
    'protocol/protocolFacade.d.ts',
    'targetedContributionAuthoring.d.ts',
    'protocol/index.d.ts',
    'contributions/index.d.ts',
] as const;
const tsxCliPath = createRequire(import.meta.url).resolve('tsx/cli');

type ExternalAuthoringFixtureBuild = Readonly<{
    root: string;
    targetedContributionDeclarationsDirectory: string;
    triageSourceDeclarationsDirectory: string;
}>;

type ExternalTargetedPackageBuild = Readonly<{
    root: string;
    targetRoot: string;
    contributorRoot: string;
    targetSdkRoot: string;
    targetPluginUiRoot: string;
    contributorSdkRoot: string;
    targetDeclaration: string;
    targetSurfaceDeclaration: string;
    targetSelectionDeclaration: string;
    targetDeclarativeAuthoringDeclaration: string;
    contributorDeclaration: string;
}>;

type ExternalTargetedRuntimeProof = Readonly<{
    actionId: string;
    descriptor: Readonly<{ kind: string; label: string }>;
    surface: Readonly<{ role: string; presentation: string }>;
    targetedSurface: Readonly<{
        reactRenderer: string;
        declarativeRenderer: string;
        selectedExactHandle: boolean;
        missingHandleFailedClosed: boolean;
        mismatchedGenerationFailedClosed: boolean;
        duplicateHandleFailedClosed: boolean;
        entryId: string;
    }>;
    diagnostic: Readonly<{
        acceptedUtf8Bytes: number;
        targetAcceptedContributorSerializedValue: boolean;
        contributorAcceptedTargetSerializedValue: boolean;
        utf8ByteLimit: number;
        multiByteOverLimitRejected: boolean;
        asciiOverLimitRejected: boolean;
    }>;
    composer: Readonly<{
        reference: Readonly<{
            title: Readonly<{ key: string; fallback: string }>;
            description: Readonly<{ key: string; fallback: string }>;
            triggers: readonly string[];
        }>;
        attachment: Readonly<{
            description: Readonly<{ key: string; fallback: string }>;
            cardinality: string;
            valueSchemaType: string;
            preparedValueSchemaType: string;
            runtime: Readonly<{
                prepareForSend: boolean;
            }>;
            display: string;
            pickerRenderer: string;
            previewRenderer: string;
            previewPresentation: string;
        }>;
        control: Readonly<{
            renderer: string;
            presentation: string;
            layout: string;
            compactRenderer: string;
            overflowLabel: Readonly<{ key: string; fallback: string }>;
        }>;
        region: Readonly<{
            placement: string;
            renderer: string;
        }>;
    }>;
}>;

type InstalledPackageJson = Readonly<{
    dependencies?: Readonly<Record<string, string>>;
}>;

let fixtureBuild: ExternalAuthoringFixtureBuild | undefined;
let externalTargetedPackageBuild: ExternalTargetedPackageBuild | undefined;
const builtArtifactDescribe = process.env.HAPPIER_PLUGIN_SDK_SOURCE_ONLY === '1'
    ? describe.skip
    : describe;

async function runFixtureCommand(label: string, args: readonly string[]): Promise<void> {
    await runBoundedFixtureCommand(label, fixtureRoot, args);
}

async function compileFixture(configFileName: string, args: readonly string[] = []): Promise<void> {
    await runFixtureCommand(`TypeScript fixture ${configFileName}`, [
        join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
        '-p',
        join(fixtureRoot, configFileName),
        ...args,
    ]);
}

async function typecheckExternalTargetedSourceFixture(): Promise<void> {
    await runBoundedFixtureCommand('external target and contributor source NodeNext typecheck', externalTargetedPackageFixtureRoot, [
        join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
        '-p',
        externalTargetedSourceTypecheckConfigPath,
    ]);
}


async function typecheckExternalAgentRuntimeSourceFixture(): Promise<void> {
    await runBoundedFixtureCommand('external Agent runtime source NodeNext typecheck', externalTargetedPackageFixtureRoot, [
        join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
        '-p',
        externalAgentRuntimeSourceTypecheckConfigPath,
    ]);
}

async function removeFixtureBuild(root: string): Promise<void> {
    await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
    });
}

async function requireBuiltSdkArtifact(path: string, description: string): Promise<void> {
    try {
        await access(path);
    } catch {
        throw new Error(`Real built Plugin SDK closure is missing ${description}: ${path}`);
    }
}

async function readSdkBundledDependencyNames(): Promise<readonly string[]> {
    const packageJson = JSON.parse(
        await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ) as Readonly<{ bundledDependencies?: readonly string[] }>;
    const bundled = packageJson.bundledDependencies ?? [];
    if (bundled.length === 0) {
        throw new Error('Real built Plugin SDK closure declares no bundledDependencies');
    }
    return bundled;
}

async function copyBuiltSdkArtifact(targetRoot: string): Promise<void> {
    await Promise.all([
        requireBuiltSdkArtifact(join(packageRoot, 'package.json'), 'package.json'),
        requireBuiltSdkArtifact(join(packageRoot, 'dist'), 'dist'),
    ]);
    await mkdir(dirname(targetRoot), { recursive: true });
    await cp(join(packageRoot, 'package.json'), join(targetRoot, 'package.json'), { force: true });
    await cp(join(packageRoot, 'dist'), join(targetRoot, 'dist'), { force: true, recursive: true });
    // `bundledDependencies` ship inside the SDK tarball, so npm unpacks them
    // under the installed SDK and never at the author's own root. Nesting them
    // the same way here is what makes this fixture able to observe the author's
    // real inference surface: a declaration the SDK reaches through a bundled
    // package is unnameable from the author's package, and TypeScript stops the
    // author's declaration build with TS2883 instead of emitting a specifier
    // their own consumers cannot resolve. Hoisting them to the shared closure
    // silently makes every such reference resolvable and hides the defect.
    await linkInstalledPackages(targetRoot, packageRoot, await readSdkBundledDependencyNames());
}

async function copyBuiltPluginUiArtifact(targetRoot: string): Promise<void> {
    await Promise.all([
        requireBuiltSdkArtifact(join(pluginUiPackageRoot, 'package.json'), 'Plugin UI package.json'),
        requireBuiltSdkArtifact(join(pluginUiPackageRoot, 'dist'), 'Plugin UI dist'),
    ]);
    await mkdir(dirname(targetRoot), { recursive: true });
    await cp(join(pluginUiPackageRoot, 'package.json'), join(targetRoot, 'package.json'), { force: true });
    await cp(join(pluginUiPackageRoot, 'dist'), join(targetRoot, 'dist'), { force: true, recursive: true });
}

function packagePathParts(packageName: string): readonly string[] {
    const parts = packageName.split('/');
    if (packageName.startsWith('@') ? parts.length !== 2 : parts.length !== 1) {
        throw new Error(`Unsupported package name in real built Plugin SDK closure: ${packageName}`);
    }
    return parts;
}

async function findInstalledDependencyRoot(sourcePackageRoot: string, packageName: string): Promise<string> {
    const packageParts = packagePathParts(packageName);
    let lookupRoot = sourcePackageRoot;
    while (true) {
        const candidate = join(lookupRoot, 'node_modules', ...packageParts);
        try {
            await access(join(candidate, 'package.json'));
            return candidate;
        } catch {
            const parent = dirname(lookupRoot);
            if (parent === lookupRoot) {
                throw new Error(
                    `Real built Plugin SDK closure cannot resolve ${packageName} from ${sourcePackageRoot}`,
                );
            }
            lookupRoot = parent;
        }
    }
}

async function linkBuiltRuntimeDependencyClosure(
    closureRoot: string,
    sourcePackageRoot: string,
): Promise<void> {
    const packageJson = JSON.parse(
        await readFile(join(sourcePackageRoot, 'package.json'), 'utf8'),
    ) as InstalledPackageJson;
    // Only the SDK itself needs two independent physical package roots. Link
    // its direct, installed dependencies instead of recursively dereferencing
    // every workspace package and its transient build directories. Node then
    // resolves each package's own real closure from its installed location.
    //
    // `bundledDependencies` are deliberately excluded: npm unpacks those inside
    // the installed SDK, not at the author's root, and `copyBuiltSdkArtifact`
    // nests them there. Hoisting them here would make Protocol resolvable from
    // the author's own package and defeat the portability assertions below.
    const bundledDependencyNames = new Set(await readSdkBundledDependencyNames());
    const hoistedDependencyNames = Object.keys(packageJson.dependencies ?? {})
        .filter((packageName) => !bundledDependencyNames.has(packageName));
    await Promise.all(hoistedDependencyNames.sort().map(async (packageName) => {
        const sourceDependencyRoot = await findInstalledDependencyRoot(sourcePackageRoot, packageName);
        const targetDependencyRoot = join(closureRoot, 'node_modules', ...packagePathParts(packageName));
        await mkdir(dirname(targetDependencyRoot), { recursive: true });
        await symlink(
            sourceDependencyRoot,
            targetDependencyRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
    }));
}

async function linkInstalledPackages(
    closureRoot: string,
    sourcePackageRoot: string,
    packageNames: readonly string[],
): Promise<void> {
    await Promise.all(packageNames.map(async (packageName) => {
        const sourceDependencyRoot = await findInstalledDependencyRoot(sourcePackageRoot, packageName);
        const targetDependencyRoot = join(closureRoot, 'node_modules', ...packagePathParts(packageName));
        await mkdir(dirname(targetDependencyRoot), { recursive: true });
        await symlink(
            sourceDependencyRoot,
            targetDependencyRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
    }));
}

/**
 * Reads the author's own emitted `.d.ts` the way their downstream consumer
 * does. A declaration build can succeed while emitting a module specifier that
 * only the SDK's own resolution reaches — a deep path outside the published
 * `exports` map, for instance — and `skipLibCheck` then degrades the whole
 * vocabulary to `any` in the consumer's build with no diagnostic at all. This
 * step compiles the emitted declarations alone with `skipLibCheck` off, so an
 * unresolvable specifier surfaces as TS2307 instead of silent erasure.
 */
async function typecheckEmittedAuthorDeclarations(
    label: string,
    authorRoot: string,
): Promise<void> {
    const configPath = join(authorRoot, 'tsconfig.emitted-declarations.json');
    await writeFile(
        configPath,
        `${JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                lib: ['ES2022', 'DOM'],
                types: [],
                strict: true,
                noEmit: true,
                skipLibCheck: false,
            },
            include: ['dist/**/*.d.ts'],
        }, undefined, 2)}\n`,
        'utf8',
    );
    await runBoundedFixtureCommand(`external ${label} emitted-declaration consumer typecheck`, authorRoot, [
        join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
        '-p',
        configPath,
    ]);
}

async function prepareExternalTargetedPackageBuild(): Promise<ExternalTargetedPackageBuild> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-external-targeted-packages-'));
    const targetRoot = join(root, 'target');
    const contributorRoot = join(root, 'contributor');
    const targetSdkRoot = join(targetRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    const targetPluginUiRoot = join(targetRoot, 'node_modules', '@happier-dev', 'plugin-ui');
    const contributorSdkRoot = join(contributorRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    try {
        await Promise.all([
            requireBuiltSdkArtifact(join(packageRoot, 'dist', 'index.js'), 'root runtime entrypoint'),
            requireBuiltSdkArtifact(join(packageRoot, 'dist', 'index.d.ts'), 'root declaration entrypoint'),
            requireBuiltSdkArtifact(
                join(packageRoot, 'dist', 'protocol', 'index.js'),
                'protocol runtime entrypoint',
            ),
            requireBuiltSdkArtifact(
                join(packageRoot, 'dist', 'protocol', 'index.d.ts'),
                'protocol declaration entrypoint',
            ),
            requireBuiltSdkArtifact(
                join(packageRoot, 'dist', 'contributions', 'index.js'),
                'contributions runtime entrypoint',
            ),
            requireBuiltSdkArtifact(
                join(packageRoot, 'dist', 'contributions', 'index.d.ts'),
                'contributions declaration entrypoint',
            ),
            requireBuiltSdkArtifact(
                join(packageRoot, 'dist', 'host', 'targeted-contributions', 'index.js'),
                'targeted contribution host decoder',
            ),
            requireBuiltSdkArtifact(join(packageRoot, 'dist', 'ui', 'index.d.ts'), 'public UI contract'),
            requireBuiltSdkArtifact(join(packageRoot, 'dist', 'ui', 'build', 'index.d.ts'), 'public UI build contract'),
            requireBuiltSdkArtifact(join(pluginUiPackageRoot, 'dist', 'index.d.ts'), 'Plugin UI declarations'),
        ]);
        // The shared parent closure comes from the SDK's declared package
        // dependencies. The two SDK package roots themselves remain physical,
        // independent copies so a module-identity shortcut cannot satisfy the
        // runtime proof.
        await linkBuiltRuntimeDependencyClosure(root, packageRoot);
        await linkInstalledPackages(root, pluginUiPackageRoot, [
            'react',
            'react-native',
            '@types/react',
            'csstype',
        ]);
        await Promise.all([
            cp(join(externalTargetedPackageFixtureRoot, 'target'), targetRoot, {
                force: true,
                recursive: true,
            }),
            cp(join(externalTargetedPackageFixtureRoot, 'contributor'), contributorRoot, {
                force: true,
                recursive: true,
            }),
        ]);
        await Promise.all([
            copyBuiltSdkArtifact(targetSdkRoot),
            copyBuiltPluginUiArtifact(targetPluginUiRoot),
            copyBuiltSdkArtifact(contributorSdkRoot),
        ]);
        const typeScriptCliPath = join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
        await runBoundedFixtureCommand('external target NodeNext declaration build', targetRoot, [
            typeScriptCliPath,
            '-p',
            join(targetRoot, 'tsconfig.json'),
        ]);
        await runBoundedFixtureCommand('external contributor NodeNext declaration build', contributorRoot, [
            typeScriptCliPath,
            '-p',
            join(contributorRoot, 'tsconfig.json'),
        ]);
        await Promise.all([
            typecheckEmittedAuthorDeclarations('target', targetRoot),
            typecheckEmittedAuthorDeclarations('contributor', contributorRoot),
        ]);
        return Object.freeze({
            root,
            targetRoot,
            contributorRoot,
            targetSdkRoot,
            targetPluginUiRoot,
            contributorSdkRoot,
            targetDeclaration: await readFile(join(targetRoot, 'dist', 'index.d.ts'), 'utf8'),
            targetSurfaceDeclaration: await readFile(join(targetRoot, 'dist', 'surface.d.ts'), 'utf8'),
            targetSelectionDeclaration: await readFile(
                join(targetRoot, 'dist', 'targetedSurfaceSelection.d.ts'),
                'utf8',
            ),
            targetDeclarativeAuthoringDeclaration: await readFile(
                join(targetRoot, 'dist', 'declarativeAuthoring.d.ts'),
                'utf8',
            ),
            contributorDeclaration: await readFile(join(contributorRoot, 'dist', 'index.d.ts'), 'utf8'),
        });
    } catch (error) {
        await removeFixtureBuild(root);
        throw error;
    }
}

function requireExternalTargetedPackageBuild(): ExternalTargetedPackageBuild {
    if (externalTargetedPackageBuild === undefined) {
        throw new Error('External targeted package build was not prepared');
    }
    return externalTargetedPackageBuild;
}

async function runExternalTargetedRuntimeProof(
    build: ExternalTargetedPackageBuild,
): Promise<ExternalTargetedRuntimeProof> {
    const runtimeOutput = await runBoundedFixtureCommand('external physical-copy runtime proof', build.root, [
        externalTargetedRuntimeProofPath,
        join(build.targetRoot, 'dist', 'index.js'),
        join(build.contributorRoot, 'dist', 'index.js'),
        join(build.targetSdkRoot, 'dist', 'index.js'),
        join(build.contributorSdkRoot, 'dist', 'index.js'),
        join(build.contributorSdkRoot, 'dist', 'host', 'targeted-contributions', 'index.js'),
    ]);
    return JSON.parse(runtimeOutput) as ExternalTargetedRuntimeProof;
}

async function prepareFixtureBuild(): Promise<ExternalAuthoringFixtureBuild> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-authoring-inference-'));
    const targetedContributionDeclarationsDirectory = join(root, 'targeted-contributions');
    const triageSourceDeclarationsDirectory = join(root, 'triage-source');
    try {
        // Each source/declaration fixture is compiled once before assertions
        // consume it. Keeping the actual compiler work in one hook avoids a
        // fresh program per assertion and makes subprocess failure evidence
        // deterministic.
        await compileFixture('tsconfig.json');
        await compileFixture('tsconfig.targetedContributions.declaration.json', [
            '--outDir',
            targetedContributionDeclarationsDirectory,
        ]);
        await compileFixture('tsconfig.triageSourceExamples.declaration.json', [
            '--outDir',
            triageSourceDeclarationsDirectory,
        ]);
        await compileFixture('tsconfig.targetedSurfaceReactAuthoring.json');
        await runFixtureCommand('Runtime authoring fixture', [
            tsxCliPath,
            '--tsconfig',
            join(fixtureRoot, 'tsconfig.runtime.json'),
            join(fixtureRoot, 'run.ts'),
        ]);
        return Object.freeze({
            root,
            targetedContributionDeclarationsDirectory,
            triageSourceDeclarationsDirectory,
        });
    } catch (error) {
        await removeFixtureBuild(root);
        throw error;
    }
}

function requireFixtureBuild(): ExternalAuthoringFixtureBuild {
    if (fixtureBuild === undefined) {
        throw new Error('External authoring fixture build was not prepared');
    }
    return fixtureBuild;
}

/**
 * Asserts an EXTERNAL AUTHOR's own emitted declaration, not the SDK's. Protocol
 * ships inside the SDK tarball and dozens of the SDK's own shipped `.d.ts`
 * name it and resolve fine, so naming Protocol is only a defect here: from the
 * author's package that declaration site is unreachable, and every consumer of
 * what they publish inherits a broken or silently-`any` type.
 */
function expectPortableExternalDeclaration(declaration: string): void {
    expect(declaration).not.toMatch(/@happier-dev\/protocol(?:["/])/u);
    expect(declaration).not.toMatch(/\bPluginJsonSchemaV2\b/u);
    expect(declaration).not.toMatch(/\bPluginActionContributionV2\b/u);
    expect(declaration).not.toMatch(/\bPluginUiJsonValueV1\b/u);
}

builtArtifactDescribe('installed public Plugin SDK author declarations', () => {
    /**
     * A tripwire, not the contract. The contract — no Protocol declaration site
     * is reachable by name through the author-facing inference surface — is
     * proven by compiling real external packages below and reading what THEY
     * emit. This check is deliberately narrower than "no shipped `.d.ts` names
     * Protocol" (36 of 286 do, and they resolve), and deliberately cheaper:
     * these are the roots an author's inference actually starts from, so a
     * Protocol declaration site appearing here is the earliest and most
     * legible signal of the same regression.
     */
    it('keeps the public author declaration roots free of Protocol-only imports', async () => {
        for (const relativePath of builtAuthorDeclarationRoots) {
            const declaration = await readFile(join(packageRoot, 'dist', relativePath), 'utf8');
            expect(declaration, relativePath).not.toMatch(/@happier-dev\/protocol(?:["/])/u);
        }
        await expect(access(join(packageRoot, 'dist', 'protocolSchema.d.ts'))).rejects.toThrow();
    });

    it('loads the built root runtime through package-exported dependency paths', async () => {
        const builtRoot = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
        expect(builtRoot.definePlugin).toBeTypeOf('function');
    });
});

describe('external target and contributor source authoring', () => {
    it('type-checks the real NodeNext packages against the current public SDK source', async () => {
        await typecheckExternalTargetedSourceFixture();
    }, fixtureCommandTimeoutMs + 5_000);
});

describe('external Agent runtime source authoring', () => {
    it('type-checks a public Agent runtime author against the current SDK source under NodeNext', async () => {
        await typecheckExternalAgentRuntimeSourceFixture();
    }, fixtureCommandTimeoutMs + 5_000);
});

describe('admitted targeted-operation source identity', () => {
    it('keeps definePlugin inference exactly assignable to ActionsService without casts', async () => {
        await compileFixture('tsconfig.admittedTargetedOperationIdentity.json');
    }, fixtureCommandTimeoutMs + 5_000);
});

builtArtifactDescribe('external physical target and contributor packages', { timeout: 180_000 }, () => {
    beforeAll(async () => {
        externalTargetedPackageBuild = await prepareExternalTargetedPackageBuild();
    }, 180_000);

    afterAll(async () => {
        if (externalTargetedPackageBuild !== undefined) {
            await removeFixtureBuild(externalTargetedPackageBuild.root);
            externalTargetedPackageBuild = undefined;
        }
    });

    it('compiles real NodeNext target and contributor packages using only public author imports', async () => {
        const build = requireExternalTargetedPackageBuild();
        expect(build.targetRoot).not.toBe(build.contributorRoot);
        expect(build.targetSdkRoot).not.toBe(build.contributorSdkRoot);
        expect(existsSync(join(build.targetSdkRoot, 'dist', 'index.js'))).toBe(true);
        expect(existsSync(join(build.targetPluginUiRoot, 'dist', 'index.js'))).toBe(true);
        expect(existsSync(join(build.contributorSdkRoot, 'dist', 'index.js'))).toBe(true);
        expectPortableExternalDeclaration(build.targetDeclaration);
        expectPortableExternalDeclaration(build.targetSurfaceDeclaration);
        expectPortableExternalDeclaration(build.targetDeclarativeAuthoringDeclaration);
        expectPortableExternalDeclaration(build.contributorDeclaration);
        // The declarative author exports INFERRED values, so these names are
        // the ones TypeScript had to reach for. Asserting they resolve through
        // published SDK subpaths is what distinguishes a portable vocabulary
        // from one that merely compiles inside this repository.
        expect(build.targetDeclarativeAuthoringDeclaration)
            .toMatch(/declarativeCollectionListNode: import\("@happier-dev\/plugin-sdk\/manifest"\)\.PluginDeclarativeCollectionListNodeV2/u);
        expect(build.targetDeclarativeAuthoringDeclaration)
            .toMatch(/declarativeComposerApplyEffect: import\("@happier-dev\/plugin-sdk\/manifest"\)\.PluginDeclarativeComposerApplyEffectV1/u);
        expect(build.targetDeclarativeAuthoringDeclaration)
            .toMatch(/declarativeItemInput: import\("@happier-dev\/plugin-sdk"\)\.PluginJsonValueV2/u);
        for (const specifier of build.targetDeclarativeAuthoringDeclaration.matchAll(
            /(?:from |import\()["']([^"']+)["']/gu,
        )) {
            const moduleSpecifier = specifier[1] ?? '';
            expect(
                moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('@happier-dev/plugin-sdk'),
                `emitted author declaration reached ${moduleSpecifier}`,
            ).toBe(true);
        }
        expect(build.targetSelectionDeclaration).not.toMatch(
            /export\s+(?:declare\s+)?type\s+PhysicalCopyDetailSurface\b/u,
        );
        expect(build.targetSelectionDeclaration).toMatch(
            /export declare function selectPhysicalCopyDetailSurface[\s\S]+\| null;/u,
        );
        expect(build.targetDeclaration).toContain('TargetedContributionSnapshot');
        expect(build.targetSurfaceDeclaration).toContain('renderPhysicalCopyTargetSurface');
        expect(build.targetDeclaration).toContain('physicalCopyTargetDetailNode');
        for (const sourcePath of [
            join(externalTargetedPackageFixtureRoot, 'target', 'src', 'index.ts'),
            join(externalTargetedPackageFixtureRoot, 'target', 'src', 'pluginUiBuild.ts'),
            join(externalTargetedPackageFixtureRoot, 'target', 'src', 'surface.tsx'),
            join(externalTargetedPackageFixtureRoot, 'target', 'src', 'targetedSurfaceSelection.ts'),
            join(externalTargetedPackageFixtureRoot, 'target', 'src', 'declarativeAuthoring.ts'),
            join(externalTargetedPackageFixtureRoot, 'contributor', 'src', 'index.ts'),
        ]) {
            const source = await readFile(sourcePath, 'utf8');
            expect(source, sourcePath).not.toMatch(/@happier-dev\/protocol(?:["/])/u);
            expect(source, sourcePath).not.toMatch(/@happier-dev\/(?:plugin-sdk|plugin-ui)\/src(?:["/])/u);
        }
    });

    it('exchanges contributor wire values through a target point from the other SDK copy without object identity', async () => {
        const proof = await runExternalTargetedRuntimeProof(requireExternalTargetedPackageBuild());
        expect(proof).toEqual({
            actionId: 'non-protocol-local-action',
            descriptor: { kind: 'issue', label: 'Physical package source' },
            surface: { role: 'detail', presentation: 'content' },
            targetedSurface: {
                reactRenderer: 'physical-copy-target-react-renderer',
                declarativeRenderer: 'physical-copy-target-declarative-renderer',
                selectedExactHandle: true,
                missingHandleFailedClosed: true,
                mismatchedGenerationFailedClosed: true,
                duplicateHandleFailedClosed: true,
                entryId: 'external-42',
            },
            diagnostic: {
                acceptedUtf8Bytes: 1_024,
                targetAcceptedContributorSerializedValue: true,
                contributorAcceptedTargetSerializedValue: true,
                utf8ByteLimit: 1_024,
                multiByteOverLimitRejected: true,
                asciiOverLimitRejected: true,
            },
            composer: {
                reference: {
                    title: { key: 'external.sources.title', fallback: 'External sources' },
                    description: {
                        key: 'external.sources.description',
                        fallback: 'Search external physical-package sources',
                    },
                    triggers: ['@', '$'],
                },
                attachment: {
                    description: {
                        key: 'external.readonly.description',
                        fallback: 'A public readonly JSON attachment contract',
                    },
                    cardinality: 'one',
                    valueSchemaType: 'array',
                    preparedValueSchemaType: 'array',
                    runtime: {
                        prepareForSend: true,
                    },
                    display: 'badge',
                    pickerRenderer: 'physical-copy-composer-renderer',
                    previewRenderer: 'physical-copy-composer-renderer',
                    previewPresentation: 'popover',
                },
                control: {
                    renderer: 'physical-copy-composer-renderer',
                    presentation: 'popover',
                    layout: 'content',
                    compactRenderer: 'physical-copy-composer-renderer',
                    overflowLabel: {
                        key: 'external.readonly.control.more',
                        fallback: 'More external choices',
                    },
                },
                region: {
                    placement: 'afterComposer',
                    renderer: 'physical-copy-composer-renderer',
                },
            },
        });
    });
});

describe('external definePlugin authoring inference fixture', { timeout: 90_000 }, () => {
    beforeAll(async () => {
        fixtureBuild = await prepareFixtureBuild();
    }, 120_000);

    afterAll(async () => {
        if (fixtureBuild !== undefined) {
            await removeFixtureBuild(fixtureBuild.root);
            fixtureBuild = undefined;
        }
    });

    it('compiles against source owners without explicit generics or package-root publication', () => {
        expect(existsSync(join(fixtureRoot, 'index.ts'))).toBe(true);
        expect(requireFixtureBuild().root).toContain('happier-plugin-sdk-authoring-inference-');
    });

    it('uses one public Account Collection declaration for manifest projection and Account storage', () => {
        expect(requireFixtureBuild().root).toContain('happier-plugin-sdk-authoring-inference-');
    });

    it('emits portable declarations for exported target and symbolic surface authoring', async () => {
        const { targetedContributionDeclarationsDirectory } = requireFixtureBuild();
        const contributionDeclaration = await readFile(
            join(targetedContributionDeclarationsDirectory, 'fixtures', 'authoring-inference', 'targetedContributionDeclarations.d.ts'),
            'utf8',
        );
        const surfaceDeclaration = await readFile(
            join(targetedContributionDeclarationsDirectory, 'fixtures', 'authoring-inference', 'targetedSurfaceAuthoring.d.ts'),
            'utf8',
        );
        expect(contributionDeclaration).not.toContain('targetedContributionPointEvidence');
        expectPortableExternalDeclaration(contributionDeclaration);
        expectPortableExternalDeclaration(surfaceDeclaration);
        expect(surfaceDeclaration).toContain('ContributionSurfaceNodeInput');
    });

    it('compiles real independent triage target and contributor entrypoints through one source-only feature protocol', async () => {
        const { triageSourceDeclarationsDirectory } = requireFixtureBuild();
        for (const declarationPath of [
            join(triageSourceDeclarationsDirectory, 'examples', 'triage-source-target', 'src', 'index.d.ts'),
            join(triageSourceDeclarationsDirectory, 'examples', 'triage-source-contributor', 'src', 'index.d.ts'),
        ]) {
            expectPortableExternalDeclaration(await readFile(declarationPath, 'utf8'));
        }
    });

    it('lets an external target author one bounded declarative contribution surface through the public protocol helper', () => {
        expect(requireFixtureBuild().root).toContain('happier-plugin-sdk-authoring-inference-');
    });

    it('type-checks a compile-only React consumer against the actual target-local admitted surface type', () => {
        expect(requireFixtureBuild().root).toContain('happier-plugin-sdk-authoring-inference-');
    });

    it('runs the named ABI and production-backed testkit through source owners', () => {
        expect(requireFixtureBuild().root).toContain('happier-plugin-sdk-authoring-inference-');
    });
});

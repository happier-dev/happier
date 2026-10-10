import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  build as EsbuildBuild,
  transform as EsbuildTransform,
} from 'esbuild';
import {
  SOURCE_CONDITION,
  bundleCliSourceSidecars,
  createWorkspaceSourceResolver,
  readCliSourceEntries,
  readWorkspacePackages,
  runtimePackageExports,
} from '../../sourceRuntimeEntries.mjs';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';
import { getCliBinaryArtifactSupportTargetUnavailableReason } from '../../componentArtifactTarget.mjs';
import {
  BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH as BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH,
  parseBundledPluginPublicationFailures,
} from '../../bundledPluginPublicationPolicy.mjs';
import {
  assertResolvedRuntimeDependencyMatchesDeclaration,
  collectExternalRuntimeDependencies,
  resolveInstalledRuntimePackage,
} from '../../workspaceRuntimeDependencies.mjs';
import {
  CLI_BINARY_TARGETS,
  resolveCliToolsPlatformDir,
  resolveCurrentBinaryTarget,
  resolveExecutableName,
  type BinaryTarget,
} from './targets.js';
import {
  commandExists,
  compileBunBinary,
  ensureFileExists,
  execOrThrow,
  resolveBunCommand,
  resolveYarnCommand,
  type RunCommand,
} from './commands.js';
import {
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../workspaces/index.js';
import { readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot } from './copyCliNodeRuntimePayload.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { stageCliProxyApiManagedRuntime } from './stageCliProxyApiManagedRuntime.js';
import { stageProcessCustodyRuntime } from './stageProcessCustodyRuntime.js';
import { writeCliBinaryArtifactRuntimeAssetBuildManifest } from './refreshCliBinaryArtifactRuntimeAssetBuildManifest.js';
import { stageIrohNativeReleaseEvidence } from './stageIrohNativeReleaseEvidence.js';
import { stageCliTargetRuntimeDependencies } from './stageCliTargetRuntimeDependencies.js';

export { getCliBinaryArtifactSupportTargetUnavailableReason } from '../../componentArtifactTarget.mjs';

export const CLI_RUNTIME_EXTERNAL_PACKAGES = [
  '@huggingface/transformers',
  'ffmpeg-static',
  'sherpa-onnx-node',
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
] as const;

const CLI_OPTIONAL_RUNTIME_PACKAGES: readonly string[] = [
  '@huggingface/transformers',
  'sherpa-onnx-node',
  'sherpa-onnx-darwin-arm64',
  'sherpa-onnx-darwin-x64',
  'sherpa-onnx-linux-arm64',
  'sherpa-onnx-linux-x64',
  'sherpa-onnx-win-arm64',
  'sherpa-onnx-win-x64',
];

// Pino and ThreadStream locate their worker scripts relative to their physical
// packages. Keep that package-owned worker layout in the runtime payload rather
// than inlining it into the shared authored graph.
const CLI_BUN_COMPILE_EXTERNAL_PACKAGES = ['pino', 'thread-stream'] as const;

const DAEMON_SUPPORT_ENTRYPOINT = '.happier-daemon-support.json';
const CLIPROXYAPI_MANAGED_RUNTIME_RELATIVE_PATH = join(
  'tools',
  'unpacked',
  'happier-cliproxyapi-managed',
);

type CliToolUnpackModule = {
  unpackTools?: (
    options: Readonly<{
      platformDir: string;
      toolsDir: string;
      tools: readonly string[];
    }>,
  ) => Promise<unknown> | unknown;
};

type CliPackageJson = Readonly<{
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}>;

export type CliBinaryArtifactSupportIdentity = Readonly<{
  fingerprint: string;
  workspaceRuntimeIdentity: string | null;
}>;

export type CliBinaryArtifactCodePayload = Readonly<{
  executableName: string;
  entrypoint: string;
  workspaceRuntimeIdentity: string;
  runtimeAssetRelativePath: string;
}>;

function assertCliNativeRuntimeTargetMatchesHost(
  target: BinaryTarget,
  commandProbe = commandExists,
): void {
  const reason = getCliBinaryArtifactSupportTargetUnavailableReason({
    target,
    commandProbe,
  });
  if (reason) throw new Error(reason);
}

function compareSupportIdentityPathNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertPhysicalPathWithinRepoRoot(
  repoRoot: string,
  path: string,
): string {
  const physicalRepoRoot = realpathSync(repoRoot);
  const physicalPath = realpathSync(path);
  const relativePath = relative(physicalRepoRoot, physicalPath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `[component-artifacts] daemon support input escapes the repository root: ${physicalPath} (root: ${physicalRepoRoot})`,
    );
  }
  return physicalPath;
}

function hashSupportInputTree({
  hash,
  repoRoot,
  sourcePath,
  label,
}: Readonly<{
  hash: ReturnType<typeof createHash>;
  repoRoot: string;
  sourcePath: string;
  label: string;
}>): void {
  const activeDirectories = new Set<string>();

  const visit = (path: string, relativePath: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      const resolvedTarget = assertPhysicalPathWithinRepoRoot(repoRoot, path);
      hash.update(`link\0${label}\0${relativePath.replaceAll('\\', '/')}\0`);
      visit(resolvedTarget, relativePath);
      return;
    }
    if (entry.isDirectory()) {
      const physicalPath = assertPhysicalPathWithinRepoRoot(repoRoot, path);
      if (activeDirectories.has(physicalPath)) {
        throw new Error(
          `[component-artifacts] daemon support input contains a directory symlink cycle: ${path}`,
        );
      }
      activeDirectories.add(physicalPath);
      hash.update(`dir\0${label}\0${relativePath.replaceAll('\\', '/')}\0`);
      for (const child of readdirSync(path, { withFileTypes: true }).sort(
        (left, right) => compareSupportIdentityPathNames(left.name, right.name),
      )) {
        visit(
          join(path, child.name),
          relativePath ? join(relativePath, child.name) : child.name,
        );
      }
      activeDirectories.delete(physicalPath);
      return;
    }
    if (!entry.isFile()) {
      throw new Error(
        `[component-artifacts] daemon support input has an unsupported file type: ${path}`,
      );
    }
    const bytes = readFileSync(path);
    hash.update(
      `file\0${label}\0${relativePath.replaceAll('\\', '/')}\0${entry.mode & 0o7777}\0${bytes.byteLength}\0`,
    );
    hash.update(bytes);
    hash.update('\0');
  };

  assertPhysicalPathWithinRepoRoot(repoRoot, sourcePath);
  visit(sourcePath, '');
}

function hashRequiredSupportInputPath({
  hash,
  repoRoot,
  sourcePath,
  label,
}: Readonly<{
  hash: ReturnType<typeof createHash>;
  repoRoot: string;
  sourcePath: string;
  label: string;
}>): void {
  if (!existsSync(sourcePath)) {
    throw new Error(
      `[component-artifacts] missing daemon support input: ${sourcePath}`,
    );
  }
  hashSupportInputTree({ hash, repoRoot, sourcePath, label });
}

function readCliPackageJson(repoRoot: string): CliPackageJson {
  const packageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as CliPackageJson;
}

function readRequiredCliRuntimePackageSpecs(repoRoot: string): ReadonlyArray<
  Readonly<{
    packageName: string;
    declaredSpec: string;
  }>
> {
  const cliPackageJson = readCliPackageJson(repoRoot);
  return CLI_RUNTIME_EXTERNAL_PACKAGES.map((packageName) => {
    const declaredSpec =
      cliPackageJson.dependencies?.[packageName] ??
      cliPackageJson.optionalDependencies?.[packageName];
    if (typeof declaredSpec !== 'string' || !declaredSpec.trim()) {
      throw new Error(
        `[component-artifacts] missing CLI runtime dependency declaration for ${packageName}`,
      );
    }
    return { packageName, declaredSpec: declaredSpec.trim() };
  });
}

function hashRuntimeDependencyTree({
  hash,
  repoRoot,
  packageJsonPath,
  resolveFromPackageJsonPath = packageJsonPath,
  destinationNodeModulesPath,
  visitedDestinations = new Set<string>(),
  activeSourcePackageDirs = new Set<string>(),
}: Readonly<{
  hash: ReturnType<typeof createHash>;
  repoRoot: string;
  packageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destinationNodeModulesPath: string;
  visitedDestinations?: Set<string>;
  activeSourcePackageDirs?: Set<string>;
}>): void {
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  ) as CliPackageJson;
  for (const dependency of collectExternalRuntimeDependencies(packageJson)) {
    let resolvedPackage: ReturnType<typeof resolveInstalledRuntimePackage>;
    try {
      resolvedPackage = resolveInstalledRuntimePackage({
        packageName: dependency.name,
        resolveFromPackageJsonPath,
        dereferenceRootDir: repoRoot,
      });
    } catch (error) {
      if (
        dependency.optional &&
        (error as NodeJS.ErrnoException | undefined)?.code ===
          'MODULE_NOT_FOUND'
      ) {
        continue;
      }
      throw error;
    }
    assertResolvedRuntimeDependencyMatchesDeclaration({
      dependency,
      resolvedPackageJsonPath: resolvedPackage.packageJsonPath,
      resolvedPackageJson: resolvedPackage.packageJson,
    });
    const physicalSourcePackageDir = assertPhysicalPathWithinRepoRoot(
      repoRoot,
      resolvedPackage.packageDir,
    );
    if (activeSourcePackageDirs.has(physicalSourcePackageDir)) continue;

    const destinationPath = join(
      destinationNodeModulesPath,
      ...dependency.name.split('/'),
    );
    if (visitedDestinations.has(destinationPath)) continue;
    visitedDestinations.add(destinationPath);
    hash.update(
      `runtime-package\0${destinationPath.replaceAll('\\', '/')}\0${dependency.declaredSpec}\0`,
    );
    hashSupportInputTree({
      hash,
      repoRoot,
      sourcePath: resolvedPackage.packageDir,
      label: `runtime-package:${destinationPath.replaceAll('\\', '/')}`,
    });

    const nextActiveSourcePackageDirs = new Set(activeSourcePackageDirs);
    nextActiveSourcePackageDirs.add(physicalSourcePackageDir);
    hashRuntimeDependencyTree({
      hash,
      repoRoot,
      packageJsonPath: resolvedPackage.packageJsonPath,
      resolveFromPackageJsonPath: realpathSync(resolvedPackage.packageJsonPath),
      destinationNodeModulesPath: join(destinationPath, 'node_modules'),
      visitedDestinations,
      activeSourcePackageDirs: nextActiveSourcePackageDirs,
    });
  }
}

/**
 * The daemon support artifact is intentionally owned by the CLI artifact
 * builder. Its identity is the exact source closure that the existing support
 * bundlers stage, plus the platform and Go toolchain that produce the managed
 * CLIProxyAPI executable. It is not a reusable cross-component layer format.
 */
export function readCliBinaryArtifactSupportIdentity({
  repoRoot,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  goVersion,
  cliProxyApiManagedRuntimeExecutablePath,
  processCustodyRuntimeExecutablePath,
}: Readonly<{
  repoRoot: string;
  target?: BinaryTarget;
  goVersion: string;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  processCustodyRuntimeExecutablePath?: string;
}>): CliBinaryArtifactSupportIdentity {
  const normalizedGoVersion = String(goVersion ?? '').trim();
  if (!normalizedGoVersion) {
    throw new Error(
      '[component-artifacts] daemon support identity requires a Go toolchain version',
    );
  }

  const hash = createHash('sha256');
  hash.update('happier:daemon-runtime-support:v3\0');
  hash.update(`target\0${target.os}\0${target.arch}\0${target.exeExt}\0`);
  hash.update(`node\0${process.version}\0`);
  hash.update(`go\0${normalizedGoVersion}\0`);
  const bundledPluginFailuresPath = join(
    repoRoot,
    'apps',
    'cli',
    BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH,
  );
  hash.update('bundled-plugin-failures\0');
  hash.update(
    existsSync(bundledPluginFailuresPath)
      ? readFileSync(bundledPluginFailuresPath)
      : 'absent',
  );
  hash.update('\0');

  const cliDir = join(repoRoot, 'apps', 'cli');
  const workspacePackages = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: cliDir,
  }).map(({ packageName, srcDir }) => ({
    packageName,
    packageJsonPath: join(srcDir, 'package.json'),
  }));
  for (const { packageName, packageJsonPath } of workspacePackages) {
    hash.update(`workspace-package\0${packageName}\0`);
    hashRuntimeDependencyTree({
      hash,
      repoRoot,
      packageJsonPath,
      destinationNodeModulesPath: join(
        'node_modules',
        ...packageName.split('/'),
        'node_modules',
      ),
    });
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      files?: string[];
    };
    for (const name of (manifest.files ?? []).filter(
      (name) => name === 'native',
    )) {
      const sourcePath = join(dirname(packageJsonPath), name);
      if (existsSync(sourcePath))
        hashSupportInputTree({
          hash,
          repoRoot,
          sourcePath,
          label: `workspace-support:${packageName}/${name}`,
        });
    }
  }

  const cliPackageJsonPath = join(cliDir, 'package.json');
  hashRuntimeDependencyTree({
    hash,
    repoRoot,
    packageJsonPath: cliPackageJsonPath,
    destinationNodeModulesPath: 'node_modules',
  });
  for (const {
    packageName,
    declaredSpec,
  } of readRequiredCliRuntimePackageSpecs(repoRoot)) {
    hash.update(`required-runtime-package\0${packageName}\0${declaredSpec}\0`);
  }

  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'apps', 'cli', 'tools', 'archives'),
    label: 'tools:archives',
  });
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'apps', 'cli', 'scripts', 'unpack-tools.cjs'),
    label: 'tools:unpack-script',
  });
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(
      repoRoot,
      'packages',
      'plugins',
      'cliproxyapi',
      'package.json',
    ),
    label: 'cliproxyapi:package-json',
  });
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(
      repoRoot,
      'packages',
      'plugins',
      'cliproxyapi',
      'managed-runtime',
    ),
    label: 'cliproxyapi:managed-runtime',
  });
  if (cliProxyApiManagedRuntimeExecutablePath) {
    hashRequiredSupportInputPath({
      hash,
      repoRoot,
      sourcePath: cliProxyApiManagedRuntimeExecutablePath,
      label: 'cliproxyapi:prebuilt-runtime',
    });
  }

  // The native process-custody runtime is part of the same publication
  // closure. Its Go module source is always an identity input; the staged
  // bytes are hashed when a release caller supplies an exact prebuilt. Without
  // one, this source closure is the canonical workspace-build input.
  hashRequiredSupportInputPath({
    hash,
    repoRoot,
    sourcePath: join(repoRoot, 'apps', 'cli', 'native', 'processcustody'),
    label: 'process-custody:module-source',
  });
  if (processCustodyRuntimeExecutablePath) {
    hashRequiredSupportInputPath({
      hash,
      repoRoot,
      sourcePath: processCustodyRuntimeExecutablePath,
      label: 'process-custody:prebuilt-runtime',
    });
  } else {
    hash.update('process-custody:runtime-input\0workspace-source\0');
  }

  // The support payload can change when its owner’s staging/finalization
  // semantics change. Keep those implementation inputs owner-local rather
  // than giving a component consumer a second closure decision.
  for (const relativePath of [
    'packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/stageCliTargetRuntimeDependencies.ts',
    'packages/cli-common/src/componentArtifacts/finalizeRuntimeArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/targets.ts',
    'packages/cli-common/nodePtySpawnHelperPermissions.cjs',
    'packages/cli-common/src/componentArtifacts/stageCliProxyApiManagedRuntime.ts',
    'packages/cli-common/src/componentArtifacts/stageProcessCustodyRuntime.ts',
    'packages/cli-common/src/componentArtifacts/cliRuntimeSidecars.ts',
    'packages/cli-common/src/workspaces/index.ts',
    'packages/cli-common/workspaceRuntimeDependencies.mjs',
    'packages/cli-common/componentArtifactTarget.mjs',
  ]) {
    hashRequiredSupportInputPath({
      hash,
      repoRoot,
      sourcePath: join(repoRoot, relativePath),
      label: `owner:${relativePath}`,
    });
  }

  return {
    fingerprint: hash.digest('hex'),
    workspaceRuntimeIdentity: null,
  };
}

async function copyCliRuntimeTools(
  repoRoot: string,
  payloadDir: string,
  target: BinaryTarget,
): Promise<void> {
  const sourceToolsDir = join(repoRoot, 'apps', 'cli', 'tools');
  const targetToolsDir = join(payloadDir, 'tools');
  const targetArchivesDir = join(targetToolsDir, 'archives');
  await mkdir(targetToolsDir, { recursive: true });
  await rm(targetArchivesDir, { recursive: true, force: true });
  await cp(join(sourceToolsDir, 'archives'), targetArchivesDir, {
    recursive: true,
  });

  const unpackToolsScript = join(
    repoRoot,
    'apps',
    'cli',
    'scripts',
    'unpack-tools.cjs',
  );
  const requireFromUnpackTools = createRequire(unpackToolsScript);
  const unpackToolsModule = requireFromUnpackTools(
    unpackToolsScript,
  ) as CliToolUnpackModule;
  if (typeof unpackToolsModule.unpackTools !== 'function') {
    throw new Error(
      '[component-artifacts] apps/cli/scripts/unpack-tools.cjs must export unpackTools()',
    );
  }

  await unpackToolsModule.unpackTools({
    platformDir: resolveCliToolsPlatformDir(target),
    toolsDir: targetToolsDir,
    tools: target.os === 'windows' ? ['ripgrep'] : ['ripgrep', 'zellij'],
  });
  await rm(targetArchivesDir, { recursive: true, force: true });
}

export async function buildCliBinaryArtifactCodePayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  externals = [],
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  externals?: string[];
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
}): Promise<CliBinaryArtifactCodePayload> {
  const bunCommand = resolveBunCommand({ commandProbe });
  if (!bunCommand)
    throw new Error(
      '[component-artifacts] bun is required to build CLI binary artifacts',
    );
  const cliDir = join(repoRoot, 'apps', 'cli');
  const requireFromProject = createRequire(join(cliDir, 'package.json'));
  const esbuild = requireFromProject('esbuild') as Readonly<{
    build: typeof EsbuildBuild;
    transform: typeof EsbuildTransform;
  }>;
  const manifest = JSON.parse(
    readFileSync(join(cliDir, 'package.json'), 'utf8'),
  ) as {
    exports?: Record<string, unknown>;
    imports?: Record<string, unknown>;
  };
  const workspacePackages = await readWorkspacePackages(repoRoot);
  const { entries, pluginMetadata } = await readCliSourceEntries({
    repoDir: repoRoot,
    manifest,
    transform: esbuild.transform,
    cliPrefix: '',
    mainOutput: 'package-dist/index',
    publicPrefix: 'package-dist',
    pluginPrefix: (name) => `node_modules/${name}`,
  });
  const mergedExternals = [
    ...new Set([
      ...CLI_RUNTIME_EXTERNAL_PACKAGES,
      ...CLI_BUN_COMPILE_EXTERNAL_PACKAGES,
      ...externals.map((value) => value.trim()).filter(Boolean),
    ]),
  ];
  await mkdir(payloadDir, { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: entries,
    outdir: payloadDir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // Each authored entry keeps its own tsconfig. Forcing the CLI tsconfig on
    // third-party JavaScript wrongly parses legacy CommonJS as strict modules.
    conditions: [SOURCE_CONDITION],
    chunkNames: 'package-dist/chunks/[name]-[hash]',
    metafile: true,
    logLevel: 'silent',
    banner: {
      js: "import {createRequire as __artifactCreateRequire} from 'node:module'; import {fileURLToPath as __artifactFileURLToPath} from 'node:url'; import {dirname as __artifactDirname} from 'node:path'; const require=__artifactCreateRequire(import.meta.url); const __artifactFilename=__artifactFileURLToPath(import.meta.url); const __artifactDirectory=__artifactDirname(__artifactFilename);",
    },
    define: {
      __dirname: '__artifactDirectory',
      __filename: '__artifactFilename',
    },
    plugins: [
      createWorkspaceSourceResolver({
        workspacePackages,
        requireFromProject,
        externalPackages: mergedExternals,
      }),
    ],
  });
  const sidecars = await bundleCliSourceSidecars({
    repoDir: repoRoot,
    outputDir: join(payloadDir, 'scripts'),
    build: esbuild.build,
    workspacePackages,
    requireFromProject,
  });
  Object.assign(result.metafile!.inputs, sidecars.metafile.inputs);
  Object.assign(result.metafile!.outputs, sidecars.metafile.outputs);
  const assets = join(cliDir, 'assets');
  if (existsSync(assets))
    await cp(assets, join(payloadDir, 'assets'), { recursive: true });
  const distInputs = Object.keys(result.metafile!.inputs).filter((file) =>
    /^(?:packages|apps)\/.*\/(?:dist|package-dist|\.happier-plugin)\//.test(
      file.replaceAll('\\', '/'),
    ),
  );
  if (distInputs.length)
    throw new Error(
      `[component-artifacts] native CLI consumed first-party built code: ${distInputs.join(', ')}`,
    );
  for (const key of Object.keys(entries).filter((key) =>
    key.startsWith('package-dist/'),
  )) {
    await writeFile(
      join(payloadDir, key + '.mjs'),
      `export * from './${key.split('/').at(-1)}.js';\n`,
    );
  }
  await writeFile(
    join(payloadDir, 'package.json'),
    JSON.stringify({
      ...manifest,
      type: 'module',
      bundledDependencies: pluginMetadata.map((item) =>
        String(item.package.name),
      ),
      main: './package-dist/index.mjs',
      module: './package-dist/index.mjs',
      exports: Object.fromEntries(
        Object.keys(manifest.exports ?? {}).map((key) => [
          key,
          `./package-dist/${key === '.' ? 'index' : key.slice(2)}.mjs`,
        ]),
      ),
      imports: Object.fromEntries(
        Object.entries(manifest.imports ?? {}).map(([key, value]) => [
          key,
          `./package-dist/${String(
            (value as Record<string, unknown>)[SOURCE_CONDITION],
          )
            .slice('./src/'.length)
            .replace(/\.[^.]+$/, '')}.mjs`,
        ]),
      ),
    }),
  );
  for (const item of pluginMetadata) {
    const pluginDir = join(payloadDir, item.prefix);
    await mkdir(join(pluginDir, '.happier-plugin'), { recursive: true });
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        ...item.package,
        type: 'module',
        exports: runtimePackageExports(item.package.exports),
      }),
    );
    for (const path of (item.package.files as string[] | undefined) ?? []) {
      if (
        path === 'package.json' ||
        path === 'src' ||
        path === 'dist' ||
        path.includes('*')
      )
        continue;
      if (path.startsWith('.happier-plugin')) continue;
      const source = join(item.sourceDir, path);
      if (existsSync(source))
        await cp(source, join(pluginDir, path), { recursive: true });
    }
    await writeFile(
      join(pluginDir, '.happier-plugin/plugin.json'),
      JSON.stringify(item.manifest),
    );
  }
  if (pluginMetadata.some((item) => item.manifest.contributes !== undefined)) {
    const uiPreparationDir = await mkdtemp(
      join(payloadDir, '.source-plugin-ui-'),
    );
    try {
      await runCommand(
        process.execPath,
        [
          '--conditions=happier-source',
          '--import',
          join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
          join(repoRoot, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs'),
        ],
        {
          cwd: repoRoot,
          input: JSON.stringify({
            repoRoot,
            outputDir: uiPreparationDir,
            plugins: pluginMetadata.map((item) => ({
              directory: String(item.package.name).slice(
                '@happier-dev/plugins-'.length,
              ),
              manifest: item.manifest,
            })),
            artifactOutputDirs: Object.fromEntries(
              pluginMetadata.map((item) => [
                String(item.package.name).slice('@happier-dev/plugins-'.length),
                join(payloadDir, item.prefix, 'dist/happier-plugin-ui'),
              ]),
            ),
          }),
        },
      );
    } finally {
      await rm(uiPreparationDir, { recursive: true, force: true });
    }
  }
  const staticAssets = join(
    cliDir,
    'src/plugins/projection/registry/static-assets',
  );
  if (existsSync(staticAssets))
    await cp(
      staticAssets,
      join(
        payloadDir,
        'package-dist/plugins/projection/registry/static-assets',
      ),
      { recursive: true },
    );
  const workspaceRuntimePackages = pluginMetadata.map((item) =>
    String(item.package.name),
  );
  const workspaceRuntimeIdentity =
    readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
      runtimeRoot: payloadDir,
      packageNames: workspaceRuntimePackages,
    }).fingerprint;
  await writeFile(
    join(payloadDir, 'package-dist/metafile.json'),
    JSON.stringify(result.metafile),
  );
  cliDistBuildManifest.writeCliDistBuildManifest(
    join(payloadDir, 'package-dist/index.mjs'),
    {
      workspaceRuntimeIdentity,
      ...(workspaceRuntimePackages.length ? { workspaceRuntimePackages } : {}),
    },
  );
  const executableName = resolveExecutableName({ baseName: 'happier', target });
  // Bun's embedded module graph and physical plugin entries have separate
  // module caches. The native engine loads the same executable-relative ESM
  // graph as plugins and child entries, preserving shared SDK/Zod identities.
  const nativeEntryDir = await mkdtemp(join(payloadDir, '.native-entry-'));
  try {
    const nativeEntry = join(nativeEntryDir, 'index.mjs');
    await writeFile(
      nativeEntry,
      "import { dirname, join } from 'node:path';\n" +
        "import { pathToFileURL } from 'node:url';\n" +
        "await import(pathToFileURL(join(dirname(process.execPath), 'package-dist', 'index.mjs')).href);\n",
    );
    await compileBinary({
      entrypoint: nativeEntry,
      bunTarget: target.bunTarget,
      outfile: join(payloadDir, executableName),
      cwd: repoRoot,
      externals: mergedExternals,
      bunCommand,
      autoloadDotenv: false,
      runCommand,
    });
  } finally {
    await rm(nativeEntryDir, { recursive: true, force: true });
  }
  return {
    executableName,
    entrypoint: executableName,
    workspaceRuntimeIdentity,
    runtimeAssetRelativePath:
      `${CLIPROXYAPI_MANAGED_RUNTIME_RELATIVE_PATH}${target.exeExt}`.replaceAll(
        '\\',
        '/',
      ),
  };
}

async function stageCliBinaryArtifactSupportPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  runCommand = execOrThrow,
  commandProbe = commandExists,
  cliProxyApiManagedRuntimeExecutablePath,
  processCustodyRuntimeExecutablePath,
  supportArtifactFingerprint,
  goVersion,
  preserveCompilePayloadAssets = false,
  includeIrohNativeReleaseEvidence = false,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  processCustodyRuntimeExecutablePath?: string;
  supportArtifactFingerprint?: string;
  goVersion?: string;
  preserveCompilePayloadAssets?: boolean;
  includeIrohNativeReleaseEvidence?: boolean;
}): Promise<
  Readonly<{
    entrypoint: string;
    workspaceRuntimeIdentity: string;
    runtimeAssetRelativePath: string;
  }>
> {
  assertCliNativeRuntimeTargetMatchesHost(target, commandProbe);
  const expectedSupportFingerprint = String(
    supportArtifactFingerprint ?? '',
  ).trim();
  const normalizedGoVersion = String(goVersion ?? '').trim();
  if (expectedSupportFingerprint && !normalizedGoVersion) {
    throw new Error(
      '[component-artifacts] daemon support publication requires its Go toolchain identity',
    );
  }
  if (expectedSupportFingerprint) {
    const before = readCliBinaryArtifactSupportIdentity({
      repoRoot,
      target,
      goVersion: normalizedGoVersion,
      cliProxyApiManagedRuntimeExecutablePath,
      processCustodyRuntimeExecutablePath,
    });
    if (before.fingerprint !== expectedSupportFingerprint) {
      throw new Error(
        `[component-artifacts] daemon support publication changed before staging (expected ${expectedSupportFingerprint}, found ${before.fingerprint})`,
      );
    }
  }

  const yarn = resolveYarnCommand({ commandProbe });
  await mkdir(payloadDir, { recursive: true });
  const runtimeSupportDirectories = preserveCompilePayloadAssets
    ? ['.project']
    : ['node_modules', 'tools', '.project'];
  await Promise.all(
    runtimeSupportDirectories.map(async (name) => {
      await rm(join(payloadDir, name), { recursive: true, force: true });
    }),
  );

  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(repoRoot, 'apps/cli/package.json'),
    destPackageDir: payloadDir,
    dereferenceRootDir: repoRoot,
    excludeRootDependencies: CLI_OPTIONAL_RUNTIME_PACKAGES,
  });
  const workspaceBundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps/cli'),
  });
  for (const { srcDir, packageName } of workspaceBundles) {
    const destination = join(
      payloadDir,
      'node_modules',
      ...packageName.split('/'),
    );
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: join(srcDir, 'package.json'),
      destPackageDir: destination,
      dereferenceRootDir: repoRoot,
    });
    // Native/static support is consumed beside the source-bundled graph.
    // Authored TypeScript and private package dist never enter this tree.
    const manifest = JSON.parse(
      readFileSync(join(srcDir, 'package.json'), 'utf8'),
    ) as { files?: string[] };
    for (const name of (manifest.files ?? []).filter(
      (name) => name === 'native',
    )) {
      const source = join(srcDir, name);
      if (existsSync(source))
        await cp(source, join(destination, name), { recursive: true });
    }
    if (existsSync(join(destination, 'native')))
      await copyFile(
        join(srcDir, 'package.json'),
        join(destination, 'package.json'),
      );
  }
  await stageCliTargetRuntimeDependencies({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    commandProbe,
  });
  const bundledPluginFailuresSource = join(
    repoRoot,
    'apps',
    'cli',
    BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH,
  );
  const bundledPluginFailuresTarget = join(
    payloadDir,
    BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH,
  );
  const publicationFailures = existsSync(bundledPluginFailuresSource)
    ? parseBundledPluginPublicationFailures(
        readFileSync(bundledPluginFailuresSource, 'utf8'),
      )
    : [];
  await mkdir(
    join(payloadDir, '.project', 'tmp', 'bundled-plugin-publication'),
    { recursive: true },
  );
  if (existsSync(bundledPluginFailuresSource)) {
    await copyFile(bundledPluginFailuresSource, bundledPluginFailuresTarget);
  } else {
    await writeFile(bundledPluginFailuresTarget, '[]\n', 'utf8');
  }
  await copyCliRuntimeTools(repoRoot, payloadDir, target);
  const cliProxyApiManagedRuntime = await stageCliProxyApiManagedRuntime({
    repoRoot,
    payloadDir,
    target,
    yarn,
    runCommand,
    prebuiltExecutablePath: cliProxyApiManagedRuntimeExecutablePath,
    publicationFailures,
  });
  await stageProcessCustodyRuntime({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    prebuiltExecutablePath: processCustodyRuntimeExecutablePath,
  });
  await stageIrohNativeReleaseEvidence({
    repoRoot,
    payloadDir,
    required: includeIrohNativeReleaseEvidence,
    runCommand,
  });
  if (expectedSupportFingerprint) {
    await writeFile(
      join(payloadDir, DAEMON_SUPPORT_ENTRYPOINT),
      `${JSON.stringify({ version: 1, artifactFingerprint: expectedSupportFingerprint })}\n`,
      'utf8',
    );
  }
  await finalizeRuntimeArtifactPayload(payloadDir, target);
  const supportHash = createHash('sha256');
  for (const name of ['node_modules', 'tools']) {
    hashRequiredSupportInputPath({
      hash: supportHash,
      repoRoot: payloadDir,
      sourcePath: join(payloadDir, name),
      label: name,
    });
  }

  if (expectedSupportFingerprint) {
    const after = readCliBinaryArtifactSupportIdentity({
      repoRoot,
      target,
      goVersion: normalizedGoVersion,
      cliProxyApiManagedRuntimeExecutablePath,
      processCustodyRuntimeExecutablePath,
    });
    if (after.fingerprint !== expectedSupportFingerprint) {
      throw new Error(
        `[component-artifacts] daemon support publication changed while staging (expected ${expectedSupportFingerprint}, found ${after.fingerprint})`,
      );
    }
  }

  return {
    entrypoint: DAEMON_SUPPORT_ENTRYPOINT,
    workspaceRuntimeIdentity: supportHash.digest('hex'),
    runtimeAssetRelativePath: relative(
      payloadDir,
      cliProxyApiManagedRuntime?.executablePath ??
        join(
          payloadDir,
          `${CLIPROXYAPI_MANAGED_RUNTIME_RELATIVE_PATH}${target.exeExt}`,
        ),
    ).replaceAll('\\', '/'),
  };
}

export async function buildCliBinaryArtifactSupportPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  runCommand = execOrThrow,
  commandProbe = commandExists,
  cliProxyApiManagedRuntimeExecutablePath,
  processCustodyRuntimeExecutablePath,
  supportArtifactFingerprint,
  goVersion,
  preserveCompilePayloadAssets = false,
  includeIrohNativeReleaseEvidence = false,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  processCustodyRuntimeExecutablePath?: string;
  supportArtifactFingerprint?: string;
  goVersion?: string;
  preserveCompilePayloadAssets?: boolean;
  includeIrohNativeReleaseEvidence?: boolean;
}): Promise<
  Readonly<{
    entrypoint: string;
    workspaceRuntimeIdentity: string;
    runtimeAssetRelativePath: string;
  }>
> {
  return await stageCliBinaryArtifactSupportPayload({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    commandProbe,
    cliProxyApiManagedRuntimeExecutablePath,
    processCustodyRuntimeExecutablePath,
    supportArtifactFingerprint,
    goVersion,
    preserveCompilePayloadAssets,
    includeIrohNativeReleaseEvidence,
  });
}

/**
 * Legacy/self-contained payload builder retained for release packaging and old
 * artifacts. Managed daemon artifacts call the two owner-local functions
 * above, then reference the immutable support payload instead.
 */
export async function buildCliBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  externals = [],
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
  cliProxyApiManagedRuntimeExecutablePath,
  processCustodyRuntimeExecutablePath,
  includeIrohNativeReleaseEvidence = false,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  externals?: string[];
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
  cliProxyApiManagedRuntimeExecutablePath?: string;
  processCustodyRuntimeExecutablePath?: string;
  includeIrohNativeReleaseEvidence?: boolean;
}): Promise<{ executableName: string; entrypoint: string }> {
  assertCliNativeRuntimeTargetMatchesHost(target, commandProbe);
  const publicationFailuresPath = join(
    repoRoot,
    'apps',
    'cli',
    BUNDLED_PLUGIN_FAILURES_RELATIVE_PATH,
  );
  if (
    existsSync(publicationFailuresPath) &&
    parseBundledPluginPublicationFailures(
      readFileSync(publicationFailuresPath, 'utf8'),
    ).length > 0
  ) {
    throw new Error(
      '[component-artifacts] release payload requires a complete bundled-plugin publication',
    );
  }
  await rm(payloadDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });
  const code = await buildCliBinaryArtifactCodePayload({
    repoRoot,
    payloadDir,
    target,
    externals,
    runCommand,
    commandProbe,
    compileBinary,
  });
  const support = await buildCliBinaryArtifactSupportPayload({
    repoRoot,
    payloadDir,
    target,
    runCommand,
    commandProbe,
    cliProxyApiManagedRuntimeExecutablePath,
    processCustodyRuntimeExecutablePath,
    // The release payload preserves legitimate assets emitted alongside the
    // Bun executable (for example its managed JS runtime). New immutable
    // daemon support artifacts stage into an empty payload instead.
    preserveCompilePayloadAssets: true,
    includeIrohNativeReleaseEvidence,
  });
  writeCliBinaryArtifactRuntimeAssetBuildManifest({
    payloadDir,
    relativePath: support.runtimeAssetRelativePath,
    workspaceRuntimeIdentity: code.workspaceRuntimeIdentity,
  });
  return {
    executableName: code.executableName,
    entrypoint: code.entrypoint,
  };
}

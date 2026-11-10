import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { packageNameOfSpecifier, SOURCE_CONDITION, workspaceSourceCompilerPaths } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { appendBoundedTail, redactFailureDiagnostic } from '../utils/proc/proc.mjs';
import { WorkspacePackageBuildError } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspacePackageInputFingerprint } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { removeOwnedDirectorySync } from '../utils/fs/fs.mjs';

export function isFirstPartyBuiltInput(key, workspacePackages) {
  key = key.replaceAll('\\', '/');
  if (!/^(?:packages|apps)\//.test(key)) return false;
  // The innermost installed package owns its files. A third-party dist tree
  // below a workspace (or bundled workspace copy) is not first-party output.
  const installed = key.split('/node_modules/').at(-1);
  if (installed !== key && !workspacePackages.has(packageNameOfSpecifier(installed))
      && !installed.startsWith('@happier-dev/')) return false;
  return /(?:^|\/)(?:dist|package-dist|\.happier-plugin)\//.test(installed);
}

export async function emitSourceAuthorPackages({ repoDir, sourceRepoDir, projectDir, runtimeDir, workspacePackages, build,
  sourceInputDigests, readSourceInput, retainedRuntime, env, signal }) {
  const started = performance.now();
  const workDir = await mkdtemp(join(runtimeDir, '.author-emission-'));
  try {
    const { withDistProjectCompilerArgs } = await import('../../../../scripts/workspaces/buildTypeScriptPackageDist.mjs');
    const { default: ts } = await import('typescript');
    // Run the existing package classification, closure and physical copier
    // directly from source, not from a workspace dist prerequisite.
    const ownerPath = join(workDir, 'workspaces.mjs');
    const ownerBuild = await build({entryPoints:[join(repoDir, 'packages/cli-common/src/workspaces/index.ts')],
      outfile:ownerPath, bundle:true, platform:'node', format:'esm', logLevel:'silent', metafile:true});
    const owner = await import(pathToFileURL(ownerPath).href);
    const bundles = owner.resolveWorkspaceBundlesFromPackageJson({repoRoot:repoDir,hostPackageDir:projectDir});
    const roots = bundles.filter(bundle => owner.sanitizeBundledPackageJson(
      workspacePackages.get(bundle.packageName).manifest).happier?.publicSdkRelease);
    const closure = new Set(owner.resolveInternalWorkspacePackageNameClosure({repoRoot:repoDir,
      packageNames:roots.map(bundle => bundle.packageName)}));
    const authorRoot = join(runtimeDir, 'authoring/node_modules');
    const codeFiles = [];
    const visit = async directory => {
      for (const entry of await readdir(directory, {withFileTypes:true})) {
        const path = join(directory,entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (!entry.isSymbolicLink()) codeFiles.push(path);
      }
    };
    // Reuse only the selected immutable bundle's package outputs. Workspace
    // currentness owns captured inputs and declared dependencies; no second
    // cache or installation-wide invalidation policy is needed here.
    const additionalInputPaths = [
      ...Object.keys(ownerBuild.metafile.inputs).map(path => resolve(path)),
      join(repoDir, 'packages/cli-common/sourceRuntimeEntries.mjs'),
      join(repoDir, 'apps/stack/scripts/build/source_author_packages.mjs'),
      fileURLToPath(import.meta.resolve('esbuild/package.json')),
      fileURLToPath(import.meta.resolve('typescript/package.json')),
    ].filter(path => existsSync(path));
    const inputIdentities = {};
    let javascriptEmissions = 0;
    // Host bundle membership is current even when the compiled public closure
    // is unchanged. These manifests are inventory, not compiler output.
    for (const bundle of bundles.filter(bundle => !closure.has(bundle.packageName))) {
      const destDir = join(authorRoot, ...bundle.packageName.split('/'));
      await mkdir(destDir, {recursive:true});
      await writeFile(join(destDir, 'package.json'), JSON.stringify(workspacePackages.get(bundle.packageName).manifest));
    }
    const retainedRoot = retainedRuntime && join(retainedRuntime.runtimeDir, 'authoring/node_modules');
    const sourcePaths = workspaceSourceCompilerPaths(workspacePackages);
    for (const bundle of bundles.filter(bundle => closure.has(bundle.packageName))) {
      const packageStarted = performance.now();
      const packageCpu = process.cpuUsage();
      try {
      const destDir = join(authorRoot, ...bundle.packageName.split('/'));
      await mkdir(destDir, {recursive:true});
      signal?.throwIfAborted();
      const dependencyNames = owner.resolveInternalWorkspacePackageNameClosure({repoRoot:repoDir,
        packageNames:[bundle.packageName]}).filter(name => name !== bundle.packageName && closure.has(name));
      const inputIdentity = readWorkspacePackageInputFingerprint({packageDir:bundle.srcDir,
        dependencyDirs:dependencyNames.map(name => join(authorRoot, ...name.split('/'))),
        dependencyIdentityPathFor:path => join(sourceRepoDir,
          relative(repoDir, workspacePackages.get(relative(authorRoot, path).split(sep).join('/')).root)),
        identitySourceRepoDir:repoDir, identityRepoDir:sourceRepoDir, installedDependencyRepoDir:sourceRepoDir,
        includeShippedFiles:true, additionalInputPaths:additionalInputPaths.map(path => relative(bundle.srcDir, path)), env});
      inputIdentities[bundle.packageName] = inputIdentity;
      const retainedPackage = retainedRoot && join(retainedRoot, ...bundle.packageName.split('/'));
      if (retainedRuntime?.authorPackageInputIdentities?.[bundle.packageName] === inputIdentity && existsSync(retainedPackage)) {
        await cp(retainedPackage, destDir, {recursive:true, verbatimSymlinks:true});
      } else {
        const compilerDir = join(workDir, ...bundle.packageName.split('/'));
        await mkdir(compilerDir, {recursive:true});
        const outputDir = join(compilerDir, 'emitted');
        const args = await withDistProjectCompilerArgs([], {projectPath:join(bundle.srcDir,'tsconfig.json'),
          workDir:compilerDir,compilerOptions:{customConditions:[SOURCE_CONDITION],paths:sourcePaths}});
        const projectPath = args[args.indexOf('--project') + 1];
        const parsed = ts.getParsedCommandLineOfConfigFile(projectPath, {}, {
          ...ts.sys, onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
          },
        });
        if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, {
          getCanonicalFileName:path=>path,getCurrentDirectory:()=>repoDir,getNewLine:()=> '\n',
        }));
        const sourceDir = join(bundle.srcDir, 'src');
        const inputFiles = parsed.fileNames.filter(path => path.startsWith(sourceDir + sep));
        const inputs = new Map();
        for (const path of inputFiles) inputs.set(path, await readSourceInput(path));
        const compilerStarted = performance.now();
        const emission = await build({entryPoints:inputFiles.filter(path => !/\.d\.[cm]?ts$/.test(path)),
          outbase:sourceDir,outdir:outputDir,bundle:false,platform:'node',format:'esm',
          ...(parsed.options.sourceMap ? {sourcemap:'external'} : {}),
          tsconfig:projectPath,logLevel:'silent',metafile:true,plugins:[{
            name:'captured-author-inputs',setup(builder) {
              builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async ({path}) => {
                const contents = inputs.get(path) ?? await readSourceInput(path);
                return {contents:contents.toString(),loader:/\.tsx$/.test(path)?'tsx':/\.[cm]?ts$/.test(path)?'ts':'js'};
              });
            },
          }]});
        for (const path of Object.keys(emission.metafile.inputs)) {
          const key = relative(repoDir, resolve(path)).replaceAll('\\', '/');
          if (isFirstPartyBuiltInput(key, workspacePackages)) throw new Error(`Source author closure consumed first-party built code: ${key}`);
        }
        for (const output of Object.values(emission.metafile.outputs)) {
          if (!output.entryPoint) continue;
          for (const imported of output.imports) {
            if (!imported.path.startsWith('.') || !imported.path.endsWith('.json')) continue;
            const path = resolve(dirname(resolve(output.entryPoint)), imported.path);
            const contents = await readSourceInput(path);
            inputs.set(path, contents);
            const target = join(outputDir, relative(sourceDir,path));
            await mkdir(dirname(target), {recursive:true});
            await writeFile(target, contents);
          }
        }
        console.error(`[source-author] phase=javascript package=${bundle.packageName} elapsedMs=${Math.round(performance.now()-compilerStarted)}`);
        javascriptEmissions++;
        owner.bundleWorkspacePackageWithRuntimeDependencies({...bundle,destDir,
          resolveFromPackageJsonPath: join(sourceRepoDir, relative(repoDir, bundle.srcDir), 'package.json'),
          dereferenceRootDir: sourceRepoDir,distDir:outputDir});
        removeOwnedDirectorySync(join(destDir, 'src'));
        // The author materializer owns declaration work. Retain its production
        // inputs within the existing physical package, so authoring later uses
        // this capture instead of reopening the moving repository.
        const declarationSource = join(destDir, 'dist/.happier-source');
        await mkdir(declarationSource,{recursive:true});
        await writeFile(join(declarationSource,'package.json'),JSON.stringify(workspacePackages.get(bundle.packageName).manifest));
        for (const [path, contents] of inputs) {
          const target = join(declarationSource, 'src', relative(sourceDir,path));
          await mkdir(dirname(target), {recursive:true});
          await writeFile(target, contents);
        }
        const config = ts.convertToTSConfig(parsed, projectPath, {
          getCurrentDirectory:()=>repoDir,useCaseSensitiveFileNames:true,
        });
        const ownPaths = {};
        for (const [specifier, targets] of Object.entries(parsed.options.paths ?? {})) {
          const ownTargets = targets.map(path=>resolve(parsed.options.baseUrl ?? parsed.options.pathsBasePath ?? compilerDir,path))
            .filter(path=>path.startsWith(sourceDir+sep));
          if (ownTargets.length) ownPaths[specifier] = ownTargets.map(path => '../../src/'+relative(sourceDir,path).split(sep).join('/'));
        }
        // Ambient declaration inputs must travel with the capture as well;
        // later author operations cannot reopen the moving checkout's @types.
        for (const name of ts.getAutomaticTypeDirectiveNames(parsed.options, ts.sys)) {
          const resolved = ts.resolveTypeReferenceDirective(name, projectPath, parsed.options, ts.sys)
            .resolvedTypeReferenceDirective;
          if (!resolved?.packageId) continue;
          owner.bundleInstalledPackageWithRuntimeDependencies({packageName:resolved.packageId.name,
            resolveFromPackageJsonPath:join(sourceRepoDir,relative(repoDir,bundle.srcDir),'package.json'),
            destNodeModulesDir:join(declarationSource,'node_modules'),dereferenceRootDir:sourceRepoDir});
        }
        const compilerOptions = {...config.compilerOptions,rootDir:'../../src',outDir:'..',
          declaration:true,declarationMap:false,emitDeclarationOnly:true,noEmit:false,noCheck:true,
          incremental:false,composite:false,paths:ownPaths,customConditions:[],
          typeRoots:['./node_modules/@types']};
        delete compilerOptions.baseUrl;
        delete compilerOptions.tsBuildInfoFile;
        await writeFile(join(declarationSource,'tsconfig.json'),JSON.stringify({compilerOptions,
          files:[...inputs.keys()].map(path=>'../../src/'+relative(sourceDir,path).split(sep).join('/'))}));
      }
      await visit(destDir);
      const cpu = process.cpuUsage(packageCpu);
      console.error(`[source-author] phase=package package=${bundle.packageName} elapsedMs=${Math.round(performance.now()-packageStarted)} parentCpuMs=${Math.round((cpu.user+cpu.system)/1000)} files=${codeFiles.length}`);
      } catch (cause) {
        signal?.throwIfAborted();
        if (cause?.name === 'AbortError') throw cause;
        const diagnostic = redactFailureDiagnostic([cause?.out, cause?.err].filter(Boolean).join('\n')
          || (cause instanceof Error ? cause.message : String(cause)), env);
        // Reuse the process owner's diagnostic budget, but retain the first
        // compiler diagnostics rather than the tail of a long error cascade.
        const excerpt = diagnostic.slice(0, appendBoundedTail('', diagnostic).length);
        throw new WorkspacePackageBuildError(new Error(
          `[source-bundle] phase=author-packages package=${redactFailureDiagnostic(bundle.packageName, env)}`
          + ` exitCode=${cause?.exitCode ?? 'null'} signal=${cause?.signal ?? 'null'}\n${excerpt}`
          + (excerpt.length < diagnostic.length ? '\n[later diagnostics omitted]' : '')));
      }
    }
    const settled = Object.values(sourceInputDigests).every(digest => digest !== null);
    console.error(`[source-author] phase=closure status=${javascriptEmissions ? 'emitted' : 'reused'} elapsedMs=${Math.round(performance.now()-started)} compilers=0 javascriptEmissions=${javascriptEmissions} files=${codeFiles.length}`);
    return { codeFiles, inputIdentities: settled ? inputIdentities : undefined };
  } finally {
    removeOwnedDirectorySync(workDir);
  }
}

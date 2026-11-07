import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { packageNameOfSpecifier, SOURCE_CONDITION, workspaceSourceCompilerPaths } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { appendBoundedTail, redactFailureDiagnostic, runCapture } from '../utils/proc/proc.mjs';
import { WorkspacePackageBuildError } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspacePackageInputFingerprint } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

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
    const { resolveTypeScriptCliInvocation, matchesNativeTypeScriptInputVersion } = await import('../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs');
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
    // currentness owns captured inputs and dependency declarations; no second
    // cache or installation-wide invalidation policy is needed here.
    const additionalInputPaths = [
      ...Object.keys(ownerBuild.metafile.inputs).map(path => resolve(path)),
      join(repoDir, 'packages/cli-common/sourceRuntimeEntries.mjs'),
      join(repoDir, 'apps/stack/scripts/build/source_author_packages.mjs'),
    ].filter(path => existsSync(path));
    const inputIdentities = {};
    let compilers = 0;
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
        const buildInfoPath = join(compilerDir, 'build.tsbuildinfo');
        const args = await withDistProjectCompilerArgs(['--outDir',outputDir,'--tsBuildInfoFile',buildInfoPath,
          '--incremental','--noCheck'], {projectPath:join(bundle.srcDir,'tsconfig.json'),workDir:compilerDir,
          compilerOptions:{rootDir:repoDir,customConditions:[SOURCE_CONDITION],paths:sourcePaths,declaration:true,
            noEmit:false,emitDeclarationOnly:false}});
        const invocation = resolveTypeScriptCliInvocation({args,workspaceDir:repoDir,admissionClass:'source-bundle',env});
        const compilerStarted = performance.now();
        await runCapture(invocation.command, [...invocation.argsPrefix,...args], {cwd:repoDir,ownedProcessGroup:true,env,signal});
        compilers++;
        console.error(`[source-author] phase=compiler package=${bundle.packageName} elapsedMs=${Math.round(performance.now()-compilerStarted)}`);
        const info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
        for (const [index, file] of info.fileNames.entries()) {
          // Native TypeScript records its built-in libraries as bare logical
          // names, not paths relative to this caller-owned compiler directory.
          if (/^lib(?:\.[^/\\]+)?\.d\.ts$/.test(file)) continue;
          const path = realpathSync(resolve(compilerDir, file));
          // These are this build's dependency-first outputs, already traced to
          // consumed source bytes above. Checkout/installed dist stays forbidden.
          if (path.startsWith(realpathSync(authorRoot) + sep)) continue;
          const key = relative(realpathSync(repoDir), path).replaceAll('\\', '/');
          if (!/^(?:packages|apps)\//.test(key)) continue;
          if (isFirstPartyBuiltInput(key, workspacePackages)) {
            throw new Error(`Source author closure consumed first-party built code: ${key}`);
          }
          const contents = await readSourceInput(path);
          const version = typeof info.fileInfos[index] === 'string' ? info.fileInfos[index] : info.fileInfos[index].version;
          // The compiler's consumed input version is the authority. An editor
          // undo during emission cannot cache the graph under restored bytes.
          if (!await matchesNativeTypeScriptInputVersion(contents, version)) sourceInputDigests[relative(repoDir,path).split(sep).join('/')] = null;
        }
        owner.bundleWorkspacePackageWithRuntimeDependencies({...bundle,destDir,
          resolveFromPackageJsonPath: join(sourceRepoDir, relative(repoDir, bundle.srcDir), 'package.json'),
          dereferenceRootDir: sourceRepoDir,
          distDir:join(outputDir, relative(repoDir,bundle.srcDir),'src')});
      }
      // The closure is dependency-first. Later packages consume declarations
      // from this build's physical package, rather than re-inferring and
      // re-emitting every dependency's source graph. Never use checkout dist.
      for (const [specifier, targets] of Object.entries(sourcePaths)) {
        if (packageNameOfSpecifier(specifier) !== bundle.packageName) continue;
        sourcePaths[specifier] = targets.map(source => {
          if (!/\.(?:tsx?|mts|cts)$/.test(source)) return source;
          const declaration = relative(join(bundle.srcDir, 'src'), source)
            .replace(/\.(?:ts|tsx)$/, '.d.ts').replace(/\.mts$/, '.d.mts').replace(/\.cts$/, '.d.cts');
          return join(destDir, 'dist', declaration);
        });
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
    // Compiler-consumed versions still win over the captured-byte hint. A
    // graph emitted across a source change cannot certify later author reuse.
    const settled = Object.values(sourceInputDigests).every(digest => digest !== null);
    console.error(`[source-author] phase=closure status=${compilers ? 'emitted' : 'reused'} elapsedMs=${Math.round(performance.now()-started)} compilers=${compilers} files=${codeFiles.length}`);
    return { codeFiles, inputIdentities: settled ? inputIdentities : undefined };
  } finally {
    await rm(workDir, {recursive:true,force:true});
  }
}

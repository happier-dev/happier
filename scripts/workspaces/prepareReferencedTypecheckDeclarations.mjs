import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTypecheckProject } from './deriveTypecheckProjects.mjs';
import { requiresTypeScriptAdmission } from './resolveTypeScriptCliInvocation.mjs';
import { ensureWorkspacePackagesBuiltByName, readWorkspaceComponentDependencyGraph } from './ensureWorkspacePackagesBuilt.mjs';
import { WorkspacePackageBuildError } from './buildInputConvergence.mjs';
import { runCommand, exitWithCommandResult } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { resolvePackageDeclarationTarget } from './packageBuildOutputTargets.mjs';

function workspaceDeclarationPackageNames(repoDir, graph) {
  const names = [];
  for (const name of graph.closure) {
    const dir = graph.packageDirsByName.get(name);
    if (!relative(repoDir, dir).replaceAll('\\', '/').startsWith('packages/')) continue;
    const configPath = resolve(dir, 'tsconfig.json');
    if (!existsSync(configPath)) continue;
    const { parsed: { options } } = readTypecheckProject(configPath);
    if (!options.outDir || !options.declaration) continue;
    const manifest = graph.packageJsonByDir.get(dir);
    const exports = manifest.exports;
    const entries = Object.keys(exports ?? {}).some(key => key.startsWith('.'))
      ? Object.values(exports) : [exports ?? manifest.types];
    if (entries.some(value => {
      const target = resolvePackageDeclarationTarget(value);
      return target && !relative(options.outDir, resolve(dir, target)).startsWith('..');
    })) names.push(name);
  }
  return names;
}

/** Consumers of published declarations share the package owner's verified
 * receipts, emission and staging. The compiler's own project declarations
 * retain their private output paths. */
export async function prepareWorkspaceTypecheckDeclarations(componentDir, {
  env = process.env, withinTypecheckAdmission = false, signal,
} = {}) {
  const started = performance.now();
  const repoDir = coerceHappyMonorepoRootFromPath(componentDir);
  const graph = await readWorkspaceComponentDependencyGraph(componentDir, { monorepoRoot: repoDir });
  const names = graph ? workspaceDeclarationPackageNames(repoDir, graph) : [];
  const failed = [];
  const failure = (status, projects) => ({ ok: false, failure: { step: 'declaration-emission', status, projects } });
  let built = [];
  if (names.length) {
    try {
      const result = await ensureWorkspacePackagesBuiltByName(repoDir, names, {
        env, signal, buildMode: 'source-dev', maxConcurrentBuilds: 1,
        // Independent declaration requests wait for custody before reserving
        // a compiler slot. A containing typecheck already owns its capacity.
        batchAdmission: false,
        visitedNames: [graph.componentPackageJson.name],
        inheritedAdmission: withinTypecheckAdmission && requiresTypeScriptAdmission({ env }),
        onPackageBuildResult: ({ packageName, reason }) => {
          if (reason === 'failed') failed.push(packageName);
        },
      });
      if (result.stalePackages?.length) return failure(1, result.stalePackages.map(({ packageName }) => packageName));
      built = result.built;
    } catch (error) {
      if (!(error instanceof WorkspacePackageBuildError) || error.code !== 'EEXIT' || error.cause?.signal) throw error;
      return failure(error.cause?.exitCode ?? 1, failed);
    }
  }
  return { ok: true, built, declarations: built.filter(name => names.includes(name)), elapsedMs: Math.round(performance.now() - started) };
}

if (process.argv[2] === '--prepare-for-typecheck' && process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [componentDir, admissionClass, delimiter, command, ...args] = process.argv.slice(3);
  if (delimiter !== '--' || !command) throw new Error('Invalid admitted typecheck invocation');
  const cancellation = new AbortController();
  let cancelledSignal;
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    cancelledSignal ??= signal;
    cancellation.abort();
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const started = performance.now();
    process.stderr.write(`[typecheck-preparation] starting ${JSON.stringify({ component: componentDir,
      admissionClass, at: new Date().toISOString() })}\n`);
    const result = await prepareWorkspaceTypecheckDeclarations(resolve(componentDir), {
      withinTypecheckAdmission: true, signal: cancellation.signal,
    });
    cancellation.signal.throwIfAborted();
    process.stderr.write(`[typecheck-preparation] ${JSON.stringify({ component: componentDir, packageBuilds: result.built?.length ?? 0,
      ...(result.ok ? { declarations: result.declarations.length } : { failure: result.failure }),
      elapsedMs: Math.round(performance.now() - started), at: new Date().toISOString() })}\n`);
    process.stderr.write(`[typescript] starting ${JSON.stringify({ at: new Date().toISOString() })}\n`);
    const checked = await runCommand(command, args, { cwd: process.cwd(), env: process.env,
      signal: cancellation.signal, stdio: 'inherit', ownedProcessGroup: true });
    exitWithCommandResult(!result.ok && checked.status === 0 ? { ...checked, status: result.failure.status } : checked);
  } catch (error) {
    if (!cancelledSignal) process.stderr.write(`[typecheck-preparation] failed ${error.stack ?? error}\n`);
    exitWithCommandResult({ error: !cancelledSignal && error.exitCode === undefined ? error : undefined,
      status: error.exitCode, signal: cancelledSignal ?? error.signal });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

export { prepareReferencedTypecheckDeclarations, orderTypecheckProjects } from './prepareTypecheckSourceReferences.mjs';
if (process.argv[2] === '--workspace-declarations' && process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stderr.write('[typecheck-declarations] queued preparation expired after the workspace publisher changed; retry the typecheck\n');
  process.exitCode = 1;
}

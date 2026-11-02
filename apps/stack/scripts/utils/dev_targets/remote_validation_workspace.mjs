import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveWorkspaceBuildMode, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { requiresTypeScriptAdmission } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { runWorkspaceBuildAdmission } from '../proc/workspace_build_admission.mjs';
import { prepareCliSourceNativeCustody } from './native_custody_preparation.mjs';
import { resolveRemoteCommandPolicy } from './remote_commands.mjs';
import { writeJsonAtomic } from '../fs/json.mjs';
import { resolveRemoteValidationPreparationEnv } from './validation_env.mjs';
import { resolveRemoteValidationPreparationComponents } from './validation_preparation_policy.mjs';
export { resolveRemoteValidationPreparationEnv } from './validation_env.mjs';

// The explicit batch prepares producers on this worker before invoking its reader.
async function prepareTypecheckBatch({ repoDir, componentRelativeDirs, batchReader, env, signal }) {
  if (typeof batchReader.command !== 'string' || !batchReader.command
    || !Array.isArray(batchReader.args) || batchReader.args.some(value => typeof value !== 'string')) {
    throw new Error('A typecheck batch requires a reader command');
  }
  const components = [...new Set(componentRelativeDirs)].map(component =>
    resolveComponentDir(repoDir, component).componentDir);
  if (!components.length || components.some(component => !existsSync(join(component, 'package.json')))) {
    throw new Error('Workspace build batch components must belong to one monorepo');
  }
  const owner = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  const cwd = resolveComponentDir(repoDir, relative(repoDir, batchReader.cwd ?? repoDir)).componentDir;
  const policy = resolveRemoteCommandPolicy([batchReader.command, ...batchReader.args], { cwd, repoRoot: repoDir });
  const readerAdmissionClass = policy.heavyClass || 'compilation';
  const prepared = await owner.ensureWorkspacePackagesBuiltForComponents(components, {
    env, signal, buildMode: 'strict', admissionClass: readerAdmissionClass,
  });
  if (prepared.skipped.length) throw new Error('Workspace build batch components must belong to one monorepo');
  // Publication ends with the finite producer worker. Readers own capacity
  // independently; a watch reader must never retain the producers' leases.
  const readerResult = await runWorkspaceBuildAdmission({
    command: batchReader.command, args: batchReader.args, cwd, env, signal,
    locks: [], admissionClass: readerAdmissionClass,
    admissionRequired: requiresTypeScriptAdmission({ env }), stdio: 'inherit',
  });
  if (readerResult.error) throw readerResult.error;
  if (readerResult.status !== 0 || readerResult.signal) {
    throw Object.assign(new Error('Typecheck batch reader failed'),
      { exitCode: readerResult.status, signal: readerResult.signal });
  }
  return { ok: true, batch: true };
}

// The atmosphere worklet core is replica-owned (excluded from the source
// mirror): UI source tests import it, and its only producer is the checkout's
// own esbuild generator, which needs the replica's installed dependencies and
// rewrites the file only when its bytes change. Older checkouts lack it.
async function prepareUiAtmosphereCore(repoDir) {
  const generator = resolve(repoDir, 'apps/ui/tools/atmosphere/buildAtmosphereRenderers.mjs');
  if (!existsSync(generator)) return;
  const { buildAtmosphereRenderers } = await import(pathToFileURL(generator).href);
  await buildAtmosphereRenderers({ web: false });
}

function resolveComponentDir(repoDir, componentRelativeDir) {
  const repositoryRoot = resolve(repoDir);
  const raw = String(componentRelativeDir ?? '.').trim() || '.';
  if (/\0|\r|\n/.test(raw) || raw.replaceAll('\\', '/').split('/').includes('..')) {
    throw new Error('[dev-targets] validation component must stay inside the synchronized repository');
  }
  const componentDir = resolve(repositoryRoot, raw);
  const componentPath = relative(repositoryRoot, componentDir);
  if (componentPath === '..' || componentPath.startsWith(`..${sep}`)) {
    throw new Error('[dev-targets] validation component must stay inside the synchronized repository');
  }
  return { componentDir, componentPath };
}

export async function prepareRemoteValidationWorkspace({
  repoDir = resolve(process.cwd()),
  componentRelativeDir = '.',
  componentRelativeDirs = [componentRelativeDir],
  batchReader,
  validationKind = 'runtime',
  requiredTools = '',
  defaultBuildMode = validationKind === 'runtime' ? 'source-dev' : 'strict',
  env = process.env,
  signal,
  loadWorkspaceBuildOwner = async () => await import('../proc/pm.mjs'),
  loadCliBuildOwner = async () => await import('../../../../cli/scripts/buildSharedDeps.mjs'),
} = {}) {
  if (validationKind === 'typecheck' && batchReader) {
    return await prepareTypecheckBatch({ repoDir, componentRelativeDirs, batchReader,
      env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'strict' }, signal });
  }
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: env[WORKSPACE_BUILD_MODE_ENV] ?? defaultBuildMode, env,
  }) };
  const { componentDir, componentPath } = resolveComponentDir(repoDir, componentRelativeDir);
  if (!componentPath) return { ok: true, built: [], skipped: ['repository-root-script-owned'] };
  const normalizedComponentPath = componentPath.replaceAll('\\', '/');
  if (validationKind === 'source-test') {
    if (normalizedComponentPath === 'apps/cli' && requiredTools.split(/\s+/u).includes('go')) {
      await prepareCliSourceNativeCustody(repoDir, env);
    }
    if (normalizedComponentPath === 'apps/ui') await prepareUiAtmosphereCore(repoDir);
    return { ok: true, built: [], skipped: ['workspace-source-test'] };
  }
  if (validationKind === 'typecheck') {
    // Automatic declaration preparation is withdrawn after the DECLPREP C3
    // fleet rollback criterion fired. Typechecks remain readers until an
    // approved continuation establishes a replacement at the compiler owner.
    return { ok: true, built: [], skipped: ['workspace-typecheck-reader'] };
  }
  env = resolveRemoteValidationPreparationEnv(env, validationKind, defaultBuildMode);
  const livePluginHost = normalizedComponentPath === 'apps/cli' || normalizedComponentPath === 'apps/ui';
  const buildOptions = { env, ...(livePluginHost ? { isolatePluginFailures: true } : {}) };

  const { ensureWorkspacePackagesBuiltForComponent } = await loadWorkspaceBuildOwner();
  if (livePluginHost) {
    const {
      resolveCliBundledWorkspacePackageNames,
      publishBundledPluginArtifactsAfterWorkspaceBuild,
    } = await loadCliBuildOwner();
    // The CLI bundled selection mixes host workspaces with bundled plugins.
    // The canonical publication owner selects the bundled-plugin subset — and
    // skips publication when it is empty — so mixed selections never reach the
    // plugin-only generator CLI.
    await publishBundledPluginArtifactsAfterWorkspaceBuild({
      repoRoot: resolve(repoDir),
      workspaceNames: resolveCliBundledWorkspacePackageNames({ repoRoot: resolve(repoDir) }),
      env,
      publicationMode: 'live',
      // These generated files are deliberately replica-owned and absent from
      // Mutagen. Preparation must materialize them, not check a nonexistent
      // local projection or synchronize the primary checkout's stale bytes.
      // Only materialize outputs excluded from the one-way source replica.
      // Source-synchronized projections remain untouched so the following
      // check can still detect drift in the authoritative checkout bytes.
      bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
    });
  }
  const components = resolveRemoteValidationPreparationComponents(normalizedComponentPath, validationKind);
  const result = await ensureWorkspacePackagesBuiltForComponent(resolve(repoDir, components[0]), buildOptions);
  for (const component of components.slice(1)) {
    // The UI owns only its bundled UI package subset. The publisher above
    // makes source-derived plugin manifests and immutable artifact outputs
    // current before either component preparation can validate a newly
    // declared artifact, while this pass still prepares the complete CLI host
    // closure consumed by the UI validation command.
    await ensureWorkspacePackagesBuiltForComponent(resolve(repoDir, component), buildOptions);
  }
  if (normalizedComponentPath === 'apps/ui') {
    // This inventory is replica-owned too. Current package outputs do not
    // imply that its declaration references were regenerated on this host.
    const { generateBundledPluginUiArtifacts } = await import(pathToFileURL(
      join(componentDir, 'scripts/generateBundledPluginUiArtifacts.mjs'),
    ).href);
    await generateBundledPluginUiArtifacts({ repoRoot: resolve(repoDir), mode: 'write', publicationMode: 'live' });
  }
  return result;
}

function readComponentRelativeDir(argv) {
  const argument = argv.find((value) => value.startsWith('--component-relative-dir='));
  if (!argument) throw new Error('usage: remote_validation_preparation.mjs --component-relative-dir=PATH');
  return argument.slice('--component-relative-dir='.length);
}

function readValidationKind(argv) {
  const argument = argv.find((value) => value.startsWith('--validation-kind='));
  return argument ? argument.slice('--validation-kind='.length) : 'runtime';
}

export async function runRemoteValidationPreparationCli() {
  if (process.argv[2] === '--typecheck-batch-worker') {
    const request = JSON.parse(process.argv[3]);
    try {
      const owner = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
      await owner.runWorkspaceBuildBatchWorker(request);
    }
    catch (error) {
      if (!existsSync(request.resultPath)) await writeJsonAtomic(request.resultPath, { code: error.code, message: error.message });
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (process.argv[2] === '--typecheck-batch') {
    const args = process.argv.slice(3);
    const delimiter = args.indexOf('--');
    if (delimiter < 0 || !args[delimiter + 1]) throw new Error('Typecheck batch requires -- followed by its reader command');
    const options = args.slice(0, delimiter);
    const repo = options.find(value => value.startsWith('--repo-dir='));
    const repoDir = repo ? resolve(repo.slice('--repo-dir='.length)) : resolve(process.cwd());
    const cwd = options.find(value => value.startsWith('--reader-cwd='));
    try {
      await prepareRemoteValidationWorkspace({ repoDir, validationKind: 'typecheck',
        componentRelativeDirs: options.filter(value => value.startsWith('--component-relative-dir='))
          .map(value => value.slice('--component-relative-dir='.length)),
        batchReader: { command: args[delimiter + 1], args: args.slice(delimiter + 2),
          cwd: cwd ? resolve(repoDir, cwd.slice('--reader-cwd='.length)) : repoDir },
      });
    } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
  } else {
  const repo = process.argv.slice(2).find(value => value.startsWith('--repo-dir='));
  const repoDir = repo ? resolve(repo.slice('--repo-dir='.length)) : resolve(process.cwd());
  const executorRepoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const kind = readValidationKind(process.argv.slice(2));
  const mode = process.argv.slice(2).find(value => value.startsWith('--default-build-mode='))?.slice('--default-build-mode='.length)
    ?? (kind === 'runtime' ? 'source-dev' : 'strict');
  const env = { ...process.env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: process.env[WORKSPACE_BUILD_MODE_ENV] ?? mode, env: process.env,
  }) };
  if (repo && resolve(repoDir) !== resolve(executorRepoRoot) && kind !== 'source-test' && kind !== 'typecheck') {
    // The selected checkout owns its package graph and emitted output.
    const { ensureWorkspacePackagesBuiltForComponent } = await import(pathToFileURL(resolve(repoDir, 'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs')).href);
    await ensureWorkspacePackagesBuiltForComponent(resolveComponentDir(repoDir, readComponentRelativeDir(process.argv.slice(2))).componentDir, { env: resolveRemoteValidationPreparationEnv(env, kind, mode) });
  } else {
    await prepareRemoteValidationWorkspace({
      repoDir,
      componentRelativeDir: readComponentRelativeDir(process.argv.slice(2)),
      validationKind: kind,
      requiredTools: process.argv.slice(2).find(value => value.startsWith('--required-tools='))?.slice('--required-tools='.length) ?? '',
      env,
    });
  }
  }
}

import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  validationKind = 'runtime',
  env = process.env,
  loadWorkspaceBuildOwner = async () => await import('../proc/pm.mjs'),
  loadCliBuildOwner = async () => await import('../../../../cli/scripts/buildSharedDeps.mjs'),
} = {}) {
  const { componentDir, componentPath } = resolveComponentDir(repoDir, componentRelativeDir);
  if (!componentPath) return { ok: true, built: [], skipped: ['repository-root-script-owned'] };
  const normalizedComponentPath = componentPath.replaceAll('\\', '/');
  if (validationKind === 'source-test') {
    return { ok: true, built: [], skipped: ['workspace-source-test'] };
  }
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
  // Declaration consumers still invoke dependency package builds, including
  // staged plugin UI artifacts that require the publisher's packed manifests.
  // Typechecks stop at their own component's dependency admission instead of
  // adding the CLI component dependency pass below.
  if (validationKind === 'typecheck') {
    return await ensureWorkspacePackagesBuiltForComponent(componentDir, buildOptions);
  }
  const result = await ensureWorkspacePackagesBuiltForComponent(componentDir, buildOptions);
  if (normalizedComponentPath === 'apps/ui') {
    // The UI owns only its bundled UI package subset. The publisher above
    // makes source-derived plugin manifests and immutable artifact outputs
    // current before either component preparation can validate a newly
    // declared artifact, while this pass still prepares the complete CLI host
    // closure consumed by the UI validation command.
    await ensureWorkspacePackagesBuiltForComponent(resolve(repoDir, 'apps', 'cli'), buildOptions);
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

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  await prepareRemoteValidationWorkspace({
    componentRelativeDir: readComponentRelativeDir(process.argv.slice(2)),
    validationKind: readValidationKind(process.argv.slice(2)),
  });
}

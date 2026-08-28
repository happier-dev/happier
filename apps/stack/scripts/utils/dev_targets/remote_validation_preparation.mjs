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
  env = process.env,
  loadWorkspaceBuildOwner = async () => await import('../proc/pm.mjs'),
  loadCliBuildOwner = async () => await import('../../../../cli/scripts/buildSharedDeps.mjs'),
} = {}) {
  const { componentDir, componentPath } = resolveComponentDir(repoDir, componentRelativeDir);
  if (!componentPath) return { ok: true, built: [], skipped: ['repository-root-script-owned'] };

  const { ensureWorkspacePackagesBuiltForComponent } = await loadWorkspaceBuildOwner();
  const result = await ensureWorkspacePackagesBuiltForComponent(componentDir, { env });
  const normalizedComponentPath = componentPath.replaceAll('\\', '/');
  if (normalizedComponentPath === 'apps/cli' || normalizedComponentPath === 'apps/ui') {
    if (normalizedComponentPath === 'apps/ui') {
      // The UI owns only its bundled UI package subset, while the projection
      // publisher validates the complete CLI-bundled plugin membership before
      // atomically writing the ignored CLI and platform UI artifacts.
      await ensureWorkspacePackagesBuiltForComponent(resolve(repoDir, 'apps', 'cli'), { env });
    }
    const {
      resolveCliBundledWorkspacePackageNames,
      runCanonicalBundledPluginArtifactPublisher,
    } = await loadCliBuildOwner();
    const workspaceNames = resolveCliBundledWorkspacePackageNames({ repoRoot: resolve(repoDir) });
    await runCanonicalBundledPluginArtifactPublisher({
      repoRoot: resolve(repoDir),
      workspaceNames,
      env,
      // These generated files are deliberately replica-owned and absent from
      // Mutagen. Preparation must materialize them, not check a nonexistent
      // local projection or synchronize the primary checkout's stale bytes.
      mode: 'write',
    });
  }
  return result;
}

function readComponentRelativeDir(argv) {
  const argument = argv.find((value) => value.startsWith('--component-relative-dir='));
  if (!argument) throw new Error('usage: remote_validation_preparation.mjs --component-relative-dir=PATH');
  return argument.slice('--component-relative-dir='.length);
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  await prepareRemoteValidationWorkspace({
    componentRelativeDir: readComponentRelativeDir(process.argv.slice(2)),
  });
}

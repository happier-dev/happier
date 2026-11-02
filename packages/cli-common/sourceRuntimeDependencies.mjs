import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Completed artifacts retain their marker identity, not a future writer generation. */
export function buildInputDependencyIdentityMatches(left, right) {
  return Boolean(left && right && left.writerActive === false && right.writerActive === false && left.identity === right.identity);
}

/** A new install invalidates captured topology even with identical manifests.
 * Launches without a runtime closure retain their installation-wide comparison. */
export function sourceRuntimeDependencyIdentityMatches(captured, current) {
  return typeof captured?.markerPath === 'string' && typeof captured?.generationPath === 'string'
    && buildInputDependencyIdentityMatches(captured, current)
    && (current.generation === undefined || captured.generation === current.generation);
}

export class SourceRuntimeReloadRequiredError extends Error {
  code = 'SOURCE_RUNTIME_RELOAD_REQUIRED';
  phase = 'dependencies';
  retryable = false;

  constructor(component = 'daemon') {
    super('Source runtime dependencies changed or are unavailable. Reload the Stack from current source.');
    this.name = 'SourceRuntimeReloadRequiredError';
    this.component = component;
    this.entryGraph = component;
  }
}

function readOptionalJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** A retained graph shares the installed dependency tree. Check its existing
 * publication identity at launch demand, before any child links absolute imports.
 * Installed runtimes have no source-bundle record and keep their own lifecycle. */
export async function assertSourceRuntimeDependenciesCurrent({ entrypoint, record, component = 'daemon', env = process.env, signal }) {
  signal?.throwIfAborted();
  if (!entrypoint) return;
  try {
    record ??= readOptionalJson(join(resolve(dirname(entrypoint), '../../..'), 'source-bundle.json'));
    if (!record) return;
    const captured = record.dependencyPublication;
    // Older source captures cannot prove their installed-tree binding. An
    // explicit current-source reload publishes the locators with that identity.
    if (!sourceRuntimeDependencyIdentityMatches(captured, captured)) {
      throw new SourceRuntimeReloadRequiredError(component);
    }
    let generation = readOptionalJson(captured.generationPath);
    if (generation?.generation != null && generation.generation !== generation.completedGeneration) {
      // Only the source checkout's dependency owner knows whether this is an
      // active writer or an interrupted installation. Reuse its cancellable
      // release wait; completed launches do not load preparation tooling.
      const installDir = dirname(dirname(captured.markerPath));
      const { waitForDependencyRefresh } = await import(pathToFileURL(join(installDir,
        'apps/stack/scripts/utils/proc/dependency_refresh.mjs')).href);
      await waitForDependencyRefresh({ installDir, env, signal });
      generation = readOptionalJson(captured.generationPath);
    }
    const marker = readOptionalJson(captured.markerPath);
    const identity = typeof marker?.identity === 'string' ? marker.identity : null;
    // A completed reinstall can retain exactly the same dependency content.
    // An unfinished publication is unavailable until its producer completes it.
    const writerActive = generation?.generation != null && generation.generation !== generation.completedGeneration;
    if (writerActive) throw new SourceRuntimeReloadRequiredError(component);
    if (!sourceRuntimeDependencyIdentityMatches(captured, { identity, writerActive,
      ...(record.runtimeDependencyClosure ? { generation: generation?.generation ?? null } : {}) })) {
      const closure = record.runtimeDependencyClosure;
      if (identity && closure && component === 'daemon') {
        const installDir = dirname(dirname(captured.markerPath));
        const { readSourceRuntimeDependencyIdentity } = await import(pathToFileURL(join(installDir,
          'apps/stack/scripts/build/source_author_inputs.mjs')).href);
        if (readSourceRuntimeDependencyIdentity({ imports: closure.imports, signal }) === closure.identity) return;
      }
      throw new SourceRuntimeReloadRequiredError(component);
    }
  } catch {
    signal?.throwIfAborted();
    // Filesystem/JSON diagnostics contain local paths, not useful recovery facts.
    throw new SourceRuntimeReloadRequiredError(component);
  }
}

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Retained entrypoints re-read their capture on each launch. Keep a successful
// closure decision at this owner until the installed publication changes.
const validatedRuntimeDependencies = new Map();
const dependencyObservers = new Map();

/** Observe admission decisions; this never performs a dependency check. */
export function observeSourceRuntimeDependencies(entrypoint, listener) {
  const listeners = dependencyObservers.get(entrypoint) ?? new Set();
  dependencyObservers.set(entrypoint, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) dependencyObservers.delete(entrypoint);
  };
}

/** Completed artifacts retain their marker identity, not a future writer generation. */
export function buildInputDependencyIdentityMatches(left, right) {
  return Boolean(left && right && left.writerActive === false && right.writerActive === false && left.identity === right.identity);
}

/** The publication vocabulary is classified once for all dependency consumers. */
export function dependencyOutputAffectsComponent(output, component) {
  return component === 'server' || output !== 'server-generated-client:prisma';
}

function componentGeneration(publication, component) {
  return component === 'server' || publication.completedExpoGeneration === undefined
    ? publication.generation : publication.completedExpoGeneration;
}

/** A new install invalidates captured topology even with identical manifests.
 * Servers retain the global generation; other captures use the existing
 * non-server output projection. Legacy captures without it stay conservative. */
export function sourceRuntimeDependencyIdentityMatches(captured, current, component = 'daemon') {
  return typeof captured?.markerPath === 'string' && typeof captured?.generationPath === 'string'
    && buildInputDependencyIdentityMatches(captured, current)
    && (current.generation === undefined || componentGeneration(captured, component) === componentGeneration(current, component));
}

export class SourceRuntimeReloadRequiredError extends Error {
  code = 'SOURCE_RUNTIME_RELOAD_REQUIRED';
  phase = 'dependencies';
  retryable = false;

  constructor(component = 'daemon', subtype = 'check_failed') {
    super('Source runtime dependencies changed or are unavailable. Reload the Stack from current source.');
    this.name = 'SourceRuntimeReloadRequiredError';
    this.subtype = subtype;
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
async function checkSourceRuntimeDependenciesCurrent({ entrypoint, record, component = 'daemon', env = process.env, signal }) {
  signal?.throwIfAborted();
  if (!entrypoint) return;
  try {
    record ??= readOptionalJson(join(resolve(dirname(entrypoint), '../../..'), 'source-bundle.json'));
    if (!record) return;
    const captured = record.dependencyPublication;
    // Older source captures cannot prove their installed-tree binding. An
    // explicit current-source reload publishes the locators with that identity.
    if (!sourceRuntimeDependencyIdentityMatches(captured, captured, component)) {
      throw new SourceRuntimeReloadRequiredError(component, 'no_closure');
    }
    let generation = readOptionalJson(captured.generationPath);
    if (generation?.generation != null && generation.generation !== generation.completedGeneration) {
      validatedRuntimeDependencies.delete(entrypoint);
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
    if (writerActive) throw new SourceRuntimeReloadRequiredError(component, 'writer_active');
    const closure = record.runtimeDependencyClosure;
    const compareGeneration = closure || (component === 'server' && captured.generation !== undefined);
    const current = { identity, writerActive, ...(compareGeneration ? {
      generation: generation?.generation ?? null, completedExpoGeneration: generation?.completedExpoGeneration,
    } : {}) };
    if (!sourceRuntimeDependencyIdentityMatches(captured, current, component)) {
      if (identity && closure) {
        const validated = validatedRuntimeDependencies.get(entrypoint);
        if (validated?.closureIdentity === closure.identity
          && validated.markerPath === captured.markerPath && validated.generationPath === captured.generationPath
          && sourceRuntimeDependencyIdentityMatches(validated, current, component)) return;
        const installDir = dirname(dirname(captured.markerPath));
        const { readSourceRuntimeDependencyIdentity } = await import(pathToFileURL(join(installDir,
          'apps/stack/scripts/build/source_author_inputs.mjs')).href);
        if (readSourceRuntimeDependencyIdentity({ imports: closure.imports, signal }) === closure.identity) {
          validatedRuntimeDependencies.set(entrypoint, { ...current, closureIdentity: closure.identity,
            markerPath: captured.markerPath, generationPath: captured.generationPath });
          return;
        }
        throw new SourceRuntimeReloadRequiredError(component, 'closure_changed');
      }
      throw new SourceRuntimeReloadRequiredError(component, closure ? 'check_failed' : 'no_closure');
    }
  } catch (error) {
    validatedRuntimeDependencies.delete(entrypoint);
    signal?.throwIfAborted();
    if (error instanceof SourceRuntimeReloadRequiredError) throw error;
    // Filesystem/JSON diagnostics contain local paths, not useful recovery facts.
    throw new SourceRuntimeReloadRequiredError(component);
  }
}

export async function assertSourceRuntimeDependenciesCurrent(options) {
  let status = null;
  try {
    await checkSourceRuntimeDependenciesCurrent(options);
  } catch (error) {
    if (error instanceof SourceRuntimeReloadRequiredError) status = { code: error.code, subtype: error.subtype };
    throw error;
  } finally {
    if (!options.signal?.aborted) {
      for (const listener of dependencyObservers.get(options.entrypoint) ?? []) listener(status);
    }
  }
}

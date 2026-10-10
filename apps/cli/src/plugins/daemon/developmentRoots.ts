import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { resolveBundledActivationSourceRepoRoot } from '@/plugins/runtime/bundledActivationSource';
import { defaultCanImportFirstPartyPluginSource, isExecutingFirstPartySourceRuntime } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { isSupportedPluginAuthorSourceExtension } from '@/plugins/runtime/loadPluginModule';
import {
  startPluginDevelopmentSourceObserver,
  type PluginDevelopmentSourceObservation,
  type PluginDevelopmentSourceObserverHandle,
} from '@/plugins/authoring/sourceObserver';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import {
  bindPluginRuntimeSourceAuthority,
  type DevelopmentPluginSourceCustody,
  type PluginRuntimeSourceAuthority,
} from '@/plugins/runtime/sourceAuthority';

export type DaemonPluginDevelopmentObservation = PluginDevelopmentSourceObservation;

export type DaemonPluginDevelopmentSubmission = Omit<
  Extract<DaemonPluginDevelopmentObservation, { ok: true }>,
  'request'
> & Readonly<{
  request: Extract<PluginDevelopmentSourceObservation, { ok: true }>['request'] & Readonly<{
    observedRevision: number;
  }>;
}>;

export type DaemonPluginDevelopmentPhase =
  | 'observing'
  | 'preparing_dependencies'
  | 'compiling'
  | 'validating'
  | 'active'
  | 'retained_incumbent'
  | 'unavailable';

export type DaemonPluginDevelopmentStatus = Readonly<{
  roots: readonly Readonly<{
    kind: 'home' | 'workspace' | 'explicit';
    rootPath: string;
    trusted: boolean;
    persisted: boolean;
  }>[];
  plugins: readonly Readonly<{
    sourceRootPath: string;
    pluginId?: string;
    phase: DaemonPluginDevelopmentPhase;
    occurrenceId?: string;
    uiArtifactDigest?: string;
    diagnostic?: Readonly<{ code: string; message?: string }>;
  }>[];
}>;

export type DaemonPluginDevelopmentControlRequest =
  | Readonly<{
      kind: 'registerWorkspace';
      projectRoot: string;
      trust?: 'accept' | 'deny';
    }>
  | Readonly<{ kind: 'registerExplicit'; rootPath: string; sdkRegistryOrigin?: string }>
  | Readonly<{ kind: 'unregisterExplicit'; rootPath: string }>
  | Readonly<{ kind: 'invalidate' | 'reload'; rootPath: string }>
  | Readonly<{ kind: 'status' }>;

export type DaemonPluginDevelopmentControlResult =
  | Readonly<{ kind: 'status'; status: DaemonPluginDevelopmentStatus }>
  | Readonly<{
      kind: 'trustRequired';
      projectRoot: string;
      pluginRoot: string;
      status: DaemonPluginDevelopmentStatus;
    }>
  | Readonly<{ kind: 'failed'; code: string; message: string; status: DaemonPluginDevelopmentStatus }>;

export type PendingWorkspaceProjectTrust = Readonly<{
  pendingChangeId: string;
  projectRoot: string;
  pluginRoot: string;
}>;

type DevelopmentSubmissionResult = Readonly<{
  kind: string;
  pluginId?: string;
  occurrenceId?: string;
  code?: string;
  message?: string;
  uiArtifactDigest?: string;
}>;

type CollectionObserverHandle = Readonly<{ stop(): void }>;

const PersistedDevelopmentRootsSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.enum(['accepted', 'denied'])),
  explicitRoots: z.array(z.object({
    rootPath: z.string(),
    sdkRegistryOrigin: z.string().optional(),
  }).strict()),
}).strict();

type PersistedDevelopmentRoots = Readonly<{
  version: 1;
  projects: Readonly<Record<string, 'accepted' | 'denied'>>;
  explicitRoots: readonly Readonly<{
    rootPath: string;
    sdkRegistryOrigin?: string;
  }>[];
}>;

type DevelopmentRootState = {
  kind: 'home' | 'workspace' | 'explicit';
  rootPath: string;
  trusted: boolean;
  persisted: boolean;
  collection: boolean;
  sdkRegistryOrigin?: string;
  observer?: CollectionObserverHandle;
  candidates: Set<string>;
  reconciling: boolean;
  reconcileAgain: boolean;
};

type DevelopmentSourceState = {
  handle: PluginDevelopmentSourceObserverHandle | null;
  owners: Set<string>;
  resolvedRoot: string;
  admitted: boolean;
};

const EMPTY_PERSISTED_STATE: PersistedDevelopmentRoots = Object.freeze({
  version: 1,
  projects: Object.freeze({}),
  explicitRoots: Object.freeze([]),
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isPluginCandidate(path: string, isDirectory: boolean): Promise<boolean> {
  if (!isDirectory) {
    return isSupportedPluginAuthorSourceExtension(path);
  }
  return await pathExists(join(path, 'package.json'))
    || await pathExists(join(path, '.happier-plugin', 'plugin.json'));
}

async function listCollectionCandidates(rootPath: string): Promise<readonly string[]> {
  try {
    const canonicalRoot = await realpath(rootPath);
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    const candidates = await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) return null;
      const path = join(canonicalRoot, entry.name);
      const canonicalPath = await realpath(path);
      if (!isCanonicalAbsolutePathInsideRoot(canonicalRoot, canonicalPath)) return null;
      const candidateStat = await stat(canonicalPath);
      if (!candidateStat.isFile() && !candidateStat.isDirectory()) return null;
      return await isPluginCandidate(canonicalPath, candidateStat.isDirectory()) ? canonicalPath : null;
    }));
    return Object.freeze(candidates.filter((path): path is string => path !== null).sort());
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
}

function defaultStartCollectionObserver(
  rootPath: string,
  onChange: () => void,
): Promise<CollectionObserverHandle> {
  return Promise.resolve({
    stop: startFileWatcher(rootPath, onChange, { emitInitial: false }),
  });
}

function defaultStartSourceObserver(
  rootPath: string,
  onObservation: (
    observation: DaemonPluginDevelopmentObservation,
  ) => Promise<'adopted' | 'retained'>,
  sdkRegistryOrigin?: string,
): Promise<PluginDevelopmentSourceObserverHandle> {
  return startPluginDevelopmentSourceObserver({
    projectRoot: rootPath,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
    onObservation,
  });
}

export type DaemonPluginDevelopmentRootsOwner = Readonly<{
  initialize(): Promise<void>;
  control(request: DaemonPluginDevelopmentControlRequest): Promise<DaemonPluginDevelopmentControlResult>;
  readStatus(): DaemonPluginDevelopmentStatus;
  /** Workspace discoveries still awaiting one remembered project decision. */
  readPendingProjectTrusts(): readonly PendingWorkspaceProjectTrust[];
  resolveDevelopmentSourceAuthority(input: Readonly<{
    pluginId: string;
    rootPath: string;
  }>): Extract<PluginRuntimeSourceAuthority, DevelopmentPluginSourceCustody> | null;
  /** Exact process-local admission check for all home, workspace, and explicit sources. */
  isDevelopmentSourceRegistered(rootPath: string): boolean;
  stop(): Promise<void>;
  /** Owner-level persistence assertion; never a daemon control or public API. */
  readPersistedStateForTest(): Promise<PersistedDevelopmentRoots>;
}>;

/**
 * The daemon-lifetime owner of trusted development-root discovery and source
 * observation. It reuses the authoring observer for source classification and
 * coalescing; clients only register roots, invalidate them, and read status.
 */
export function createDaemonPluginDevelopmentRootsOwner(params: Readonly<{
  happyHomeDir: string;
  submitObservation(observation: DaemonPluginDevelopmentSubmission): Promise<DevelopmentSubmissionResult>;
  startCollectionObserver?: (
    rootPath: string,
    onChange: () => void,
  ) => Promise<CollectionObserverHandle>;
  startSourceObserver?: (
    rootPath: string,
    onObservation: (
      observation: DaemonPluginDevelopmentObservation,
    ) => Promise<'adopted' | 'retained'>,
    sdkRegistryOrigin?: string,
  ) => Promise<PluginDevelopmentSourceObserverHandle>;
  invalidateSource?: (rootPath: string) => Promise<void>;
  prepareSourceRemoval?: (input: Readonly<{
    pluginId: string;
    registeredRootId: string;
  }>) => Promise<Readonly<{
    abort(): Promise<void>;
    adopt(): Promise<void>;
  }> | null>;
}>): DaemonPluginDevelopmentRootsOwner {
  const persistedPath = join(
    resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir }).stateDir,
    'development-roots.v1.json',
  );
  const startCollectionObserver = params.startCollectionObserver ?? defaultStartCollectionObserver;
  const startSourceObserver = params.startSourceObserver ?? defaultStartSourceObserver;
  const roots = new Map<string, DevelopmentRootState>();
  const sources = new Map<string, DevelopmentSourceState>();
  // Product-build membership admits only these exact first-party checkout roots
  // when the bundled loader selects source mode; packaged custody stays separate.
  const bundledRepoRoot = resolveBundledActivationSourceRepoRoot(import.meta.url);
  const frozenSourceRuntime = isExecutingFirstPartySourceRuntime(import.meta.url)
    && !defaultCanImportFirstPartyPluginSource();
  const firstPartySourcePluginIds = new Map<string, string>(BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map((metadata) => [
    resolve(bundledRepoRoot, 'packages', 'plugins', metadata.pluginPackageId),
    metadata.pluginId,
  ]));
  const pluginStatusBySource = new Map<string, DaemonPluginDevelopmentStatus['plugins'][number]>();
  const observedRevisionBySource = new Map<string, number>();
  const pendingProjectTrustByProjectRoot = new Map<string, PendingWorkspaceProjectTrust>();
  let persistedState: PersistedDevelopmentRoots = EMPTY_PERSISTED_STATE;
  let stopped = false;

  const readPersistedState = async (): Promise<PersistedDevelopmentRoots> => {
    try {
      return PersistedDevelopmentRootsSchema.parse(JSON.parse(await readFile(persistedPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return EMPTY_PERSISTED_STATE;
      throw error;
    }
  };

  const persist = async (): Promise<void> => {
    await writeJsonAtomic(persistedPath, persistedState);
  };

  const clearPendingProjectTrust = (projectRoot: string): void => {
    pendingProjectTrustByProjectRoot.delete(projectRoot);
  };

  const readOrCreatePendingProjectTrust = (
    projectRoot: string,
    pluginRoot: string,
  ): PendingWorkspaceProjectTrust => {
    const existing = pendingProjectTrustByProjectRoot.get(projectRoot);
    if (existing?.pluginRoot === pluginRoot) return existing;
    const pending = Object.freeze({
      pendingChangeId: randomUUID(),
      projectRoot,
      pluginRoot,
    });
    pendingProjectTrustByProjectRoot.set(projectRoot, pending);
    return pending;
  };

  const readStatus = (): DaemonPluginDevelopmentStatus => Object.freeze({
    roots: Object.freeze([...roots.values()]
      .map(({ kind, rootPath, trusted, persisted }) => Object.freeze({
        kind,
        rootPath,
        trusted,
        persisted,
      }))
      .sort((left, right) => left.rootPath.localeCompare(right.rootPath))),
    plugins: Object.freeze([...pluginStatusBySource.values()]
      .map((status) => Object.freeze({ ...status }))
      .sort((left, right) => left.sourceRootPath.localeCompare(right.sourceRootPath))),
  });

  const deliverObservation = async (
    sourceRootPath: string,
    observation: DaemonPluginDevelopmentObservation,
  ): Promise<'adopted' | 'retained'> => {
    const source = sources.get(sourceRootPath);
    const observedRevision = (observedRevisionBySource.get(sourceRootPath) ?? 0) + 1;
    observedRevisionBySource.set(sourceRootPath, observedRevision);
    const prior = pluginStatusBySource.get(sourceRootPath);
    if (!observation.ok) {
      const primaryDiagnostic = observation.diagnostics[0] ?? {
        code: 'plugin_dev_observation_failed' as const,
        message: 'Plugin development source observation failed',
      };
      if (primaryDiagnostic.code === 'plugin_dev_project_missing' && prior?.pluginId) {
        let prepared: Awaited<ReturnType<NonNullable<typeof params.prepareSourceRemoval>>> = null;
        try {
          prepared = params.prepareSourceRemoval
            ? await params.prepareSourceRemoval({
                pluginId: prior.pluginId,
                registeredRootId: sourceRootPath,
              })
            : null;
          if (observedRevisionBySource.get(sourceRootPath) !== observedRevision) {
            await prepared?.abort().catch(() => undefined);
            return 'retained';
          }
          if (source) source.admitted = false;
          await prepared?.adopt();
          observedRevisionBySource.delete(sourceRootPath);
          pluginStatusBySource.set(sourceRootPath, Object.freeze({
            sourceRootPath,
            pluginId: prior.pluginId,
            phase: 'unavailable',
            diagnostic: Object.freeze(primaryDiagnostic),
          }));
          return 'retained';
        } catch (error) {
          if (source) source.admitted = true;
          await prepared?.abort().catch(() => undefined);
          retainSourceRemovalFailure(sourceRootPath, error);
          return 'retained';
        }
      }
      pluginStatusBySource.set(sourceRootPath, Object.freeze({
        sourceRootPath,
        ...(prior?.pluginId ? { pluginId: prior.pluginId } : {}),
        phase: prior?.occurrenceId ? 'retained_incumbent' : 'unavailable',
        ...(prior?.occurrenceId ? { occurrenceId: prior.occurrenceId } : {}),
        ...(prior?.uiArtifactDigest ? { uiArtifactDigest: prior.uiArtifactDigest } : {}),
        diagnostic: Object.freeze(primaryDiagnostic),
      }));
      return 'retained';
    }
    const observedPluginId = observation.request.pluginId;
    if (prior?.pluginId && observedPluginId && observedPluginId !== prior.pluginId) {
      if (source) source.admitted = false;
      observedRevisionBySource.delete(sourceRootPath);
      pluginStatusBySource.set(sourceRootPath, Object.freeze({
        ...prior,
        phase: 'retained_incumbent',
        diagnostic: Object.freeze({
          code: 'plugin_development_plugin_id_changed',
          message: `Plugin development source identity changed from '${prior.pluginId}' to '${observedPluginId}'; unregister and re-admit the root to accept a new id`,
        }),
      }));
      return 'retained';
    }
    if (source) source.admitted = true;
    pluginStatusBySource.set(sourceRootPath, Object.freeze({
      sourceRootPath,
      ...(prior?.pluginId ? { pluginId: prior.pluginId } : {}),
      phase: 'compiling',
      ...(prior?.occurrenceId ? { occurrenceId: prior.occurrenceId } : {}),
      ...(prior?.uiArtifactDigest ? { uiArtifactDigest: prior.uiArtifactDigest } : {}),
    }));
    try {
      const result = await params.submitObservation(Object.freeze({
        ...observation,
        request: Object.freeze({
          ...observation.request,
          ...(prior?.pluginId ? { pluginId: prior.pluginId } : {}),
          observedRevision,
        }),
      }));
      if (observedRevisionBySource.get(sourceRootPath) !== observedRevision) return 'retained';
      if (result.kind === 'committed') {
        pluginStatusBySource.set(sourceRootPath, Object.freeze({
          sourceRootPath,
          ...(result.pluginId ? { pluginId: result.pluginId } : prior?.pluginId ? { pluginId: prior.pluginId } : {}),
          phase: 'active',
          ...(result.occurrenceId ? { occurrenceId: result.occurrenceId } : {}),
          ...(result.uiArtifactDigest
            ? { uiArtifactDigest: result.uiArtifactDigest }
            : prior?.uiArtifactDigest
              ? { uiArtifactDigest: prior.uiArtifactDigest }
              : {}),
        }));
        return 'adopted';
      }
      pluginStatusBySource.set(sourceRootPath, Object.freeze({
        sourceRootPath,
        ...(result.pluginId ? { pluginId: result.pluginId } : prior?.pluginId ? { pluginId: prior.pluginId } : {}),
        phase: prior?.phase === 'active' || prior?.phase === 'retained_incumbent'
          ? 'retained_incumbent'
          : 'unavailable',
        ...(prior?.occurrenceId ? { occurrenceId: prior.occurrenceId } : {}),
        ...(prior?.uiArtifactDigest ? { uiArtifactDigest: prior.uiArtifactDigest } : {}),
        diagnostic: Object.freeze({
          code: result.code ?? `plugin_dev_${result.kind}`,
          ...(result.message ? { message: result.message } : {}),
        }),
      }));
      return 'retained';
    } catch (error) {
      if (observedRevisionBySource.get(sourceRootPath) !== observedRevision) return 'retained';
      pluginStatusBySource.set(sourceRootPath, Object.freeze({
        sourceRootPath,
        ...(prior?.pluginId ? { pluginId: prior.pluginId } : {}),
        phase: prior?.phase === 'active' || prior?.phase === 'retained_incumbent'
          ? 'retained_incumbent'
          : 'unavailable',
        ...(prior?.occurrenceId ? { occurrenceId: prior.occurrenceId } : {}),
        ...(prior?.uiArtifactDigest ? { uiArtifactDigest: prior.uiArtifactDigest } : {}),
        diagnostic: Object.freeze({
          code: 'plugin_dev_observation_submission_failed',
          message: error instanceof Error ? error.message : 'Development candidate submission failed',
        }),
      }));
      return 'retained';
    }
  };

  const attachSource = async (
    ownerRoot: string,
    sourcePath: string,
    sdkRegistryOrigin?: string,
  ): Promise<void> => {
    const canonicalSource = await realpath(sourcePath);
    const existing = sources.get(canonicalSource);
    if (existing) {
      existing.owners.add(ownerRoot);
      return;
    }
    if (!pluginStatusBySource.has(canonicalSource)) {
      pluginStatusBySource.set(canonicalSource, Object.freeze({
        sourceRootPath: canonicalSource,
        phase: 'observing',
      }));
    }
    const sourceStat = await stat(canonicalSource);
    const source: DevelopmentSourceState = {
      handle: null,
      owners: new Set([ownerRoot]),
      resolvedRoot: sourceStat.isFile() ? dirname(canonicalSource) : canonicalSource,
      admitted: true,
    };
    sources.set(canonicalSource, source);
    let handle: PluginDevelopmentSourceObserverHandle;
    try {
      handle = await startSourceObserver(
        canonicalSource,
        async (observation) => await deliverObservation(canonicalSource, observation),
        sdkRegistryOrigin,
      );
    } catch (error) {
      if (sources.get(canonicalSource) === source) sources.delete(canonicalSource);
      throw error;
    }
    if (sources.get(canonicalSource) !== source) {
      handle.stop();
      return;
    }
    source.handle = handle;
    void handle.failure.catch((error) => {
      const failed = sources.get(canonicalSource);
      if (failed?.handle !== handle) return;
      const prior = pluginStatusBySource.get(canonicalSource);
      if (!prior?.pluginId) {
        sources.delete(canonicalSource);
        for (const ownerRoot of failed.owners) {
          roots.get(ownerRoot)?.candidates.delete(canonicalSource);
        }
      }
      pluginStatusBySource.set(canonicalSource, Object.freeze({
        sourceRootPath: canonicalSource,
        ...(prior?.pluginId ? { pluginId: prior.pluginId } : {}),
        phase: prior?.phase === 'active' || prior?.phase === 'retained_incumbent'
          ? 'retained_incumbent'
          : 'unavailable',
        ...(prior?.occurrenceId ? { occurrenceId: prior.occurrenceId } : {}),
        ...(prior?.uiArtifactDigest ? { uiArtifactDigest: prior.uiArtifactDigest } : {}),
        diagnostic: Object.freeze({ code: 'plugin_dev_watcher_unavailable', message: error.message }),
      }));
    });
  };

  const detachSource = (ownerRoot: string, sourcePath: string): boolean => {
    const source = sources.get(sourcePath);
    if (!source) return false;
    source.owners.delete(ownerRoot);
    if (source.owners.size > 0) return false;
    source.handle?.stop();
    sources.delete(sourcePath);
    pluginStatusBySource.delete(sourcePath);
    observedRevisionBySource.delete(sourcePath);
    return true;
  };

  const retainSourceRemovalFailure = (sourcePath: string, error: unknown): void => {
    const prior = pluginStatusBySource.get(sourcePath);
    if (!prior) return;
    pluginStatusBySource.set(sourcePath, Object.freeze({
      ...prior,
      phase: prior.pluginId ? 'retained_incumbent' : 'unavailable',
      diagnostic: Object.freeze({
        code: 'plugin_development_source_removal_failed',
        message: error instanceof Error ? error.message : 'Development source removal failed',
      }),
    }));
  };

  const removeSourceOwner = async (input: Readonly<{
    ownerRoot: string;
    sourcePath: string;
    beforeAdopt?: () => Promise<void>;
    rollbackBeforeAdopt?: () => Promise<void>;
  }>): Promise<boolean> => {
    const source = sources.get(input.sourcePath);
    if (!source || !source.owners.has(input.ownerRoot)) {
      try {
        await input.beforeAdopt?.();
        return true;
      } catch (error) {
        await input.rollbackBeforeAdopt?.().catch(() => undefined);
        retainSourceRemovalFailure(input.sourcePath, error);
        return false;
      }
    }
    if (source.owners.size > 1) {
      try {
        await input.beforeAdopt?.();
        detachSource(input.ownerRoot, input.sourcePath);
        return true;
      } catch (error) {
        await input.rollbackBeforeAdopt?.().catch(() => undefined);
        retainSourceRemovalFailure(input.sourcePath, error);
        return false;
      }
    }
    const pluginId = pluginStatusBySource.get(input.sourcePath)?.pluginId;
    let prepared: Awaited<ReturnType<NonNullable<typeof params.prepareSourceRemoval>>> = null;
    try {
      prepared = pluginId && params.prepareSourceRemoval
        ? await params.prepareSourceRemoval({
            pluginId,
            registeredRootId: input.sourcePath,
          })
        : null;
      await input.beforeAdopt?.();
      source.admitted = false;
      await prepared?.adopt();
      detachSource(input.ownerRoot, input.sourcePath);
      return true;
    } catch (error) {
      source.admitted = true;
      await prepared?.abort().catch(() => undefined);
      await input.rollbackBeforeAdopt?.().catch(() => undefined);
      retainSourceRemovalFailure(input.sourcePath, error);
      return false;
    }
  };

  const reconcileCollection = async (rootPath: string): Promise<void> => {
    const root = roots.get(rootPath);
    if (!root || stopped) return;
    if (root.reconciling) {
      root.reconcileAgain = true;
      return;
    }
    root.reconciling = true;
    try {
      do {
        root.reconcileAgain = false;
        const discoveredCandidates = new Set(await listCollectionCandidates(rootPath));
        const nextCandidates = new Set(root.candidates);
        let removalFailed = false;
        for (const candidate of root.candidates) {
          if (discoveredCandidates.has(candidate)) continue;
          if (await removeSourceOwner({ ownerRoot: rootPath, sourcePath: candidate })) {
            nextCandidates.delete(candidate);
          } else {
            removalFailed = true;
          }
        }
        if (!removalFailed) {
          for (const candidate of discoveredCandidates) {
            if (!nextCandidates.has(candidate)) await attachSource(rootPath, candidate);
            nextCandidates.add(candidate);
          }
        }
        root.candidates = nextCandidates;
      } while (root.reconcileAgain && !stopped);
    } finally {
      root.reconciling = false;
    }
  };

  const registerCollection = async (
    kind: 'home' | 'workspace',
    rootPath: string,
    trustBoundaryRoot: string,
    persisted: boolean,
  ): Promise<void> => {
    const canonicalRoot = await realpath(rootPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(rootPath);
      throw error;
    });
    if (!isCanonicalAbsolutePathInsideRoot(trustBoundaryRoot, canonicalRoot)) {
      throw new Error('Plugin development collection escapes its trusted root');
    }
    if (roots.has(canonicalRoot)) return;
    const state: DevelopmentRootState = {
      kind,
      rootPath: canonicalRoot,
      trusted: true,
      persisted,
      collection: true,
      candidates: new Set<string>(),
      reconciling: false,
      reconcileAgain: false,
    };
    roots.set(canonicalRoot, state);
    await reconcileCollection(canonicalRoot);
    if (stopped) return;
    state.observer = await startCollectionObserver(canonicalRoot, () => {
      void reconcileCollection(canonicalRoot);
    });
  };

  const registerExplicit = async (rootPath: string, sdkRegistryOrigin?: string): Promise<string> => {
    const canonicalRoot = await realpath(resolve(rootPath));
    const registered = roots.get(canonicalRoot);
    if (!registered) {
      roots.set(canonicalRoot, {
        kind: 'explicit',
        rootPath: canonicalRoot,
        trusted: true,
        persisted: true,
        collection: false,
        ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
        candidates: new Set([canonicalRoot]),
        reconciling: false,
        reconcileAgain: false,
      });
      await attachSource(canonicalRoot, canonicalRoot, sdkRegistryOrigin);
    } else if (registered.kind === 'explicit' && registered.sdkRegistryOrigin !== sdkRegistryOrigin) {
      throw new Error('Unregister the plugin development root before changing its SDK registry');
    }
    const existingRegistration = persistedState.explicitRoots.find((entry) => entry.rootPath === canonicalRoot);
    if (!existingRegistration || existingRegistration.sdkRegistryOrigin !== sdkRegistryOrigin) {
      persistedState = Object.freeze({
        ...persistedState,
        explicitRoots: Object.freeze([
          ...persistedState.explicitRoots.filter((entry) => entry.rootPath !== canonicalRoot),
          Object.freeze({
            rootPath: canonicalRoot,
            ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
          }),
        ].sort((left, right) => left.rootPath.localeCompare(right.rootPath))),
      });
      await persist();
    }
    return canonicalRoot;
  };

  const unregisterExplicit = async (
    rootPath: string,
  ): Promise<DaemonPluginDevelopmentControlResult> => {
    const canonicalRoot = await realpath(resolve(rootPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(rootPath);
      throw error;
    });
    const registered = roots.get(canonicalRoot);
    const remembered = persistedState.explicitRoots.some((entry) => entry.rootPath === canonicalRoot);
    if (registered?.kind !== 'explicit' && !remembered) {
      return {
        kind: 'failed',
        code: 'plugin_development_root_not_registered',
        message: 'The exact plugin development root is not registered',
        status: readStatus(),
      };
    }

    const priorPersistedState = persistedState;
    const nextPersistedState = Object.freeze({
        ...persistedState,
        explicitRoots: Object.freeze(
          persistedState.explicitRoots.filter((entry) => entry.rootPath !== canonicalRoot),
        ),
      });
    const removed = registered?.kind !== 'explicit' || await removeSourceOwner({
      ownerRoot: canonicalRoot,
      sourcePath: canonicalRoot,
      beforeAdopt: async () => {
        persistedState = nextPersistedState;
        await persist();
      },
      rollbackBeforeAdopt: async () => {
        persistedState = priorPersistedState;
        await persist();
      },
    });
    if (!removed) {
      return {
        kind: 'failed',
        code: 'plugin_development_source_removal_failed',
        message: pluginStatusBySource.get(canonicalRoot)?.diagnostic?.message
          ?? 'Development source removal failed',
        status: readStatus(),
      };
    }
    if (registered?.kind !== 'explicit') {
      persistedState = nextPersistedState;
      await persist();
    } else roots.delete(canonicalRoot);
    return { kind: 'status', status: readStatus() };
  };

  const invalidate = async (rootPath: string): Promise<void> => {
    const canonicalRoot = await realpath(resolve(rootPath));
    if (params.invalidateSource) {
      await params.invalidateSource(canonicalRoot);
      return;
    }
    const source = sources.get(canonicalRoot);
    if (source) {
      const owners = [...source.owners];
      source.handle?.stop();
      sources.delete(canonicalRoot);
      await attachSource(owners[0] ?? canonicalRoot, canonicalRoot);
      for (const owner of owners.slice(1)) sources.get(canonicalRoot)?.owners.add(owner);
      return;
    }
    const explicitRoot = roots.get(canonicalRoot);
    if (explicitRoot?.kind === 'explicit') {
      await attachSource(canonicalRoot, canonicalRoot);
      return;
    }
    if (roots.get(canonicalRoot)?.collection) await reconcileCollection(canonicalRoot);
  };

  return Object.freeze({
    async initialize() {
      persistedState = await readPersistedState();
      const canonicalHome = await realpath(params.happyHomeDir);
      await registerCollection('home', join(canonicalHome, 'plugins'), canonicalHome, false);
      for (const registration of persistedState.explicitRoots) {
        try {
          await registerExplicit(registration.rootPath, registration.sdkRegistryOrigin);
        } catch {
          // A remembered explicit root can be temporarily unavailable. Status
          // becomes reachable again when the caller presents/reloads it.
        }
      }
    },
    async control(request) {
      if (request.kind === 'status') return { kind: 'status', status: readStatus() };
      try {
        if (request.kind === 'registerExplicit') {
          const canonicalRoot = await registerExplicit(request.rootPath, request.sdkRegistryOrigin);
          const plugin = pluginStatusBySource.get(canonicalRoot);
          if (plugin?.diagnostic
            && (plugin.phase === 'unavailable' || plugin.phase === 'retained_incumbent')) {
            return {
              kind: 'failed',
              code: plugin.diagnostic.code,
              message: plugin.diagnostic.message ?? 'Plugin development preparation failed',
              status: readStatus(),
            };
          }
          return { kind: 'status', status: readStatus() };
        }
        if (request.kind === 'unregisterExplicit') return await unregisterExplicit(request.rootPath);
        if (request.kind === 'invalidate' || request.kind === 'reload') {
          await invalidate(request.rootPath);
          return { kind: 'status', status: readStatus() };
        }
        if (request.kind !== 'registerWorkspace') {
          return { kind: 'failed', code: 'plugin_development_request_invalid', message: 'Unsupported development request', status: readStatus() };
        }
        const projectRoot = await realpath(resolve(request.projectRoot));
        const pluginRoot = join(projectRoot, '.happier', 'plugins');
        if (!await pathExists(pluginRoot)) {
          clearPendingProjectTrust(projectRoot);
          return { kind: 'status', status: readStatus() };
        }
        const canonicalPluginRoot = await realpath(pluginRoot);
        if (!isCanonicalAbsolutePathInsideRoot(projectRoot, canonicalPluginRoot)) {
          throw new Error('Workspace plugin root resolves outside the trusted project');
        }
        const existing = persistedState.projects[projectRoot];
        if (request.trust === 'deny') {
          persistedState = Object.freeze({
            ...persistedState,
            projects: Object.freeze({ ...persistedState.projects, [projectRoot]: 'denied' }),
          });
          await persist();
          clearPendingProjectTrust(projectRoot);
          return { kind: 'status', status: readStatus() };
        }
        if (request.trust !== 'accept' && existing !== 'accepted') {
          readOrCreatePendingProjectTrust(projectRoot, canonicalPluginRoot);
          return { kind: 'trustRequired', projectRoot, pluginRoot: canonicalPluginRoot, status: readStatus() };
        }
        if (existing !== 'accepted') {
          persistedState = Object.freeze({
            ...persistedState,
            projects: Object.freeze({ ...persistedState.projects, [projectRoot]: 'accepted' }),
          });
          await persist();
        }
        clearPendingProjectTrust(projectRoot);
        await registerCollection('workspace', canonicalPluginRoot, projectRoot, true);
        return { kind: 'status', status: readStatus() };
      } catch (error) {
        return {
          kind: 'failed',
          code: 'plugin_development_root_invalid',
          message: error instanceof Error ? error.message : 'Invalid plugin development root',
          status: readStatus(),
        };
      }
    },
    readStatus,
    readPendingProjectTrusts() {
      return Object.freeze([...pendingProjectTrustByProjectRoot.values()]);
    },
    resolveDevelopmentSourceAuthority(input) {
      const registeredRootId = resolve(input.rootPath);
      const firstPartyPluginId = firstPartySourcePluginIds.get(registeredRootId);
      if (firstPartyPluginId && firstPartyPluginId !== input.pluginId) return null;
      if (firstPartyPluginId && !sources.has(registeredRootId)) {
        try {
          const canonicalRoot = realpathSync(registeredRootId);
          const entryPath = frozenSourceRuntime
            ? join(registeredRootId, 'dist', 'index.js')
            : join(registeredRootId, 'src', 'index.ts');
          const canonicalEntry = realpathSync(entryPath);
          if (
            canonicalRoot !== registeredRootId
            || !isCanonicalAbsolutePathInsideRoot(canonicalRoot, canonicalEntry)
            || !statSync(canonicalEntry).isFile()
            || (frozenSourceRuntime && lstatSync(entryPath).isSymbolicLink())
          ) return null;
          sources.set(registeredRootId, {
            handle: null,
            owners: new Set(),
            resolvedRoot: canonicalRoot,
            admitted: true,
          });
          // The source loader's initial selection is revision zero; no watcher runs for bundled roots.
          observedRevisionBySource.set(registeredRootId, 0);
        } catch {
          return null;
        }
      }
      const source = sources.get(registeredRootId);
      const observedRevision = observedRevisionBySource.get(registeredRootId);
      const status = pluginStatusBySource.get(registeredRootId);
      if (
        !source
        || !source.admitted
        || observedRevision === undefined
        || (status?.pluginId !== undefined && status.pluginId !== input.pluginId)
      ) return null;
      const authority = bindPluginRuntimeSourceAuthority({
        custody: { kind: 'development', registeredRootId },
        resolvedRoot: source.resolvedRoot,
        observedRevision,
      });
      return authority.kind === 'development' ? authority : null;
    },
    isDevelopmentSourceRegistered(rootPath) {
      return sources.get(resolve(rootPath))?.admitted === true;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const root of roots.values()) root.observer?.stop();
      for (const source of sources.values()) source.handle?.stop();
      roots.clear();
      sources.clear();
      observedRevisionBySource.clear();
      pendingProjectTrustByProjectRoot.clear();
    },
    readPersistedStateForTest: readPersistedState,
  });
}

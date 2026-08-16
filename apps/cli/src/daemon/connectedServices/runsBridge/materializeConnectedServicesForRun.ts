import type { CatalogAgentId } from '@/backends/types';
import { logger as defaultLogger } from '@/ui/logger';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import type { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { buildRuntimeAccountIdentitySelectionFactV1 } from '../quotas/identity/runtimeAccountIdentityTypes';
import type { ExecutionRunConnectedServiceMaterializationProofV1 } from './contract';
import type { ExecutionRunConnectedServiceRegistrationV1 } from './contract';

/**
 * The daemon-owned run-materialization bridge (design pins 2/3: the daemon stays the SOLE
 * connected-service owner; execution runs request materialization through the scoped-token control
 * bridge instead of resolving CS themselves). `materialize` — given a run-scoped materialization key +
 * selection + agentId:
 *   1. calls the EXISTING `resolveConnectedServiceAuthForSpawn` owner (no parallel resolver), then
 *   2. REGISTERS the run in the runtime-registry RUN KEYSPACE (keyed by the run's materialization key,
 *      carrying the runner pid for liveness) so refresh distribution / canonical group-home ownership /
 *      no-restart semantics / usage identity all cover run homes for free, and
 *   3. returns the materialized env map to inject into the run's isolation bundle.
 * `release` — at run end: unregisters the run keyspace entry and runs the materialized-root cleanup
 * from the resolve result.
 *
 * Fail-closed: any resolution/materialization failure is wrapped in a typed error and rethrown, and no
 * runtime target is registered for a failed materialization.
 *
 * Same-pid coexistence: a run executes inside the session RUNNER process, whose PID is already
 * registered as the session's own (pid-keyed) CS target. Run targets live in a SEPARATE run keyspace
 * (keyed by materialization key, not pid), so a run and its host session coexist on the same pid and
 * BOTH are covered by refresh distribution — no clobber of the session registration (the
 * divergent-identity clobber class from live incident #1). The runner pid stays on the run target so a
 * dead/respawned runner prunes its runs (`unregisterPid`/`transferPid`).
 */

export type ExecutionRunConnectedServiceMaterializeRequest = Readonly<{
  runId: string;
  agentId: CatalogAgentId;
  /** The PID whose liveness anchors the registered runtime target (the runner hosting the run). */
  pid: number;
  /** Run-scoped materialization key (e.g. `execution_run:<id>`); keeps run homes distinct from sessions. */
  materializationKey: string;
  /** The run's connected-service selection, defaulted upstream exactly like session spawn defaulting. */
  connectedServicesBindingsRaw: unknown;
  sessionDirectory?: string | null;
  sessionId?: string | null;
}>;

export type ExecutionRunConnectedServiceReleaseRequest = Readonly<{
  runId: string;
  pid: number;
  materializationKey: string;
}>;

export type ExecutionRunConnectedServiceMaterializeResult = Readonly<{
  env: Record<string, string>;
  proof: ExecutionRunConnectedServiceMaterializationProofV1;
  registration: ExecutionRunConnectedServiceRegistrationV1;
}>;

/**
 * Bound `resolveConnectedServiceAuthForSpawn` shape. The daemon closes its singletons (api,
 * credentials, usage/quota stores, refresh service, base dirs) over this so the bridge never
 * re-assembles spawn context (no split-brain resolver).
 */
export type ResolveConnectedServiceAuthForRun = (
  params: Readonly<{
    agentId: CatalogAgentId;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    sessionDirectory?: string | null;
    sessionId?: string;
  }>,
) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

export class ExecutionRunConnectedServiceMaterializeError extends Error {
  readonly code = 'execution_run_connected_service_materialization_failed' as const;
  readonly runId: string;
  readonly agentId: CatalogAgentId;
  readonly cause?: unknown;

  constructor(params: Readonly<{ runId: string; agentId: CatalogAgentId; cause?: unknown }>) {
    super(`Connected-service materialization failed for execution run ${params.runId} (${params.agentId})`);
    this.name = 'ExecutionRunConnectedServiceMaterializeError';
    this.runId = params.runId;
    this.agentId = params.agentId;
    this.cause = params.cause;
  }
}

export type ExecutionRunConnectedServicesBridge = Readonly<{
  materialize: (
    request: ExecutionRunConnectedServiceMaterializeRequest,
  ) => Promise<ExecutionRunConnectedServiceMaterializeResult>;
  release: (
    request: ExecutionRunConnectedServiceReleaseRequest,
  ) => Promise<Readonly<{ released: boolean }>>;
  adoptLiveMaterialization: (input: Readonly<{
    runId: string;
    runKey: string;
    pid: number;
    agentId: CatalogAgentId;
    materializedRoot: string;
  }>) => boolean;
}>;

type RunReleaseEntry = {
  pid: number;
  cleanupOnExit: (() => void | Promise<void>) | null;
  cleanupPromise: Promise<void> | null;
};

export function createExecutionRunConnectedServicesBridge(deps: Readonly<{
  resolveAuthForSpawn: ResolveConnectedServiceAuthForRun;
  runtimeRegistry: ConnectedServiceRuntimeRegistry | null;
  /**
   * Diagnosability sink (QA2-F01): the daemon side of run materialization was log-silent, so a live
   * F01 (a run materializing on the wrong account / a leaked run home) left no daemon trace. We log
   * ONE line at materialize success and ONE at release. NEVER log env values or tokens — only the
   * COUNT of env-key names is emitted.
   */
  logger?: Pick<typeof defaultLogger, 'debug'>;
  /**
   * Resolve the broker selection identity (R3-6/NF-1) from the run's MATERIALIZED env. Injected by the
   * daemon wiring — reuses the SAME env-key reader the session-target registration uses (no second
   * resolver) — so an OpenCode/Pi run bound to a shared-managed-server pool indexes its broker identity
   * on the run target and authorizes its access-token bridge even when no live session shares the pool.
   */
  resolveBrokerSelectionIdentity?: (env: Record<string, string>) => string | null;
  createAdoptedRootCleanup?: (input: Readonly<{
    materializedRoot: string;
    materializationKey: string;
    agentId: CatalogAgentId;
  }>) => (() => void | Promise<void>) | null;
}>): ExecutionRunConnectedServicesBridge {
  const logger = deps.logger ?? defaultLogger;
  // In-memory release state keyed by the run-scoped materialization key. A daemon restart drops it;
  // the run's ephemeral root is then reclaimed by the run-root's own retention (best-effort residual).
  const releaseEntriesByKey = new Map<string, RunReleaseEntry>();
  // A1: in-flight materializations by run key. A release racing an in-flight materialize (the runner
  // abandoned the call on a transport timeout, then fired the reclaim release) must serialize BEHIND
  // it — otherwise the release sees nothing yet and the late daemon-side success (root + registered
  // target) leaks forever.
  const inFlightMaterializeByKey = new Map<string, Promise<unknown>>();

  return {
    adoptLiveMaterialization(input) {
      if (releaseEntriesByKey.has(input.runKey)) return true;
      const cleanup = deps.createAdoptedRootCleanup?.({
        materializedRoot: input.materializedRoot,
        materializationKey: input.runKey,
        agentId: input.agentId,
      }) ?? null;
      if (!cleanup) return false;
      releaseEntriesByKey.set(input.runKey, { pid: input.pid, cleanupOnExit: cleanup, cleanupPromise: null });
      return true;
    },
    async materialize(request) {
      const work = (async () => {
      let resolved: Awaited<ReturnType<ResolveConnectedServiceAuthForRun>>;
      try {
        resolved = await deps.resolveAuthForSpawn({
          agentId: request.agentId,
          materializationKey: request.materializationKey,
          connectedServicesBindingsRaw: request.connectedServicesBindingsRaw,
          sessionDirectory: request.sessionDirectory ?? null,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
      } catch (error) {
        // Fail closed: a materialization fault must surface as a typed error, never as a silent
        // fall-through to the runner's inherited (wrong) account.
        throw new ExecutionRunConnectedServiceMaterializeError({
          runId: request.runId,
          agentId: request.agentId,
          cause: error,
        });
      }

      // Fail CLOSED (POST-WAVE-REVIEW F1): the runner only calls materialize when a CS selection
      // was prepared, so an unresolved selection here would let the run silently proceed on the
      // runner's INHERITED account — an identity hazard, never a fallback.
      if (!resolved) {
        throw new ExecutionRunConnectedServiceMaterializeError({
          runId: request.runId,
          agentId: request.agentId,
        });
      }

      // Broker selection identity (NF-1): for a shared-managed-server provider (OpenCode/Pi) the run's
      // materialized env carries a stable pool identity. Indexing it on the run target lets the broker
      // access-token refresh authorize the run even when no live session shares the pool.
      const brokerSelectionIdentity = deps.resolveBrokerSelectionIdentity?.(resolved.env) ?? null;
      const connectedServiceSelectionsJson = resolved.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]?.trim() || null;

      // Register the run in the runtime-registry RUN KEYSPACE (keyed by materialization key, carrying
      // the runner pid for liveness) so it coexists with the host session's pid-keyed target and BOTH
      // receive refresh redistribution / quota fanout. No pid clobber — the session registration is
      // untouched.
      // Reclaim the exact materialization allocation. A provider's target root may be a stable
      // profile/group-owned directory (Claude), so it is never a safe cleanup derivation.
      const runRootCleanup = resolved.cleanupOnExit
        ?? resolved.cleanupMaterializationRoot
        ?? null;
      const materializedRoot = resolved.materializationRoot?.trim() || null;
      try {
        deps.runtimeRegistry?.registerRunTarget({
          runKey: request.materializationKey,
          pid: request.pid,
          agentId: request.agentId,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(brokerSelectionIdentity ? { brokerSelectionIdentity } : {}),
          connectedServicesBindingsRaw: resolved.connectedServicesBindings,
          connectedServiceSelectionsEnv: connectedServiceSelectionsJson
            ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: connectedServiceSelectionsJson }
            : null,
          materializationKey: request.materializationKey,
          sessionDirectory: request.sessionDirectory ?? null,
          runtimeAccountIdentitySelections: resolved.runtimeAccountIdentitySelections,
        });
      } catch (error) {
        deps.runtimeRegistry?.unregisterRunKey(request.materializationKey);
        try {
          await runRootCleanup?.();
        } catch {
          // Preserve the target-admission failure; release is best-effort at this boundary.
        }
        throw error;
      }
      releaseEntriesByKey.set(request.materializationKey, {
        pid: request.pid,
        cleanupOnExit: runRootCleanup,
        cleanupPromise: null,
      });

      logger.debug('[DAEMON RUN] Connected-service run materialized', {
        runId: request.runId,
        agentId: request.agentId,
        materializationKey: request.materializationKey,
        // Run targets register in the dedicated run keyspace, so they are ALWAYS covered — a session
        // target on the same pid no longer forces a skip.
        registered: true,
        // Count ONLY — never the env values/tokens themselves.
        envKeyCount: Object.keys(resolved.env).length,
      });

      return {
        env: resolved.env,
        proof: {
          v: 1 as const,
          agentId: request.agentId,
          materializationKey: request.materializationKey,
          connectedServicesBindings: resolved.connectedServicesBindings,
        },
        registration: {
          v: 1 as const,
          agentId: request.agentId,
          materializationKey: request.materializationKey,
          connectedServicesBindings: resolved.connectedServicesBindings,
          brokerSelectionIdentity,
          runtimeAccountIdentitySelections: resolved.runtimeAccountIdentitySelections.flatMap((selection) => {
            const fact = buildRuntimeAccountIdentitySelectionFactV1(selection);
            return fact ? [fact] : [];
          }),
          sessionDirectory: request.sessionDirectory ?? null,
          materializedRoot,
        },
      };
      })();

      inFlightMaterializeByKey.set(request.materializationKey, work.catch(() => {}));
      try {
        return await work;
      } finally {
        inFlightMaterializeByKey.delete(request.materializationKey);
      }
    },

    async release(request) {
      // A1: wait for any in-flight materialize of this run key first (already-settled or absent is a
      // no-op) so a client-abandoned-but-daemon-successful materialization is visible to the reclaim.
      // Bounded transitively: the materialize work itself is bounded by the resolver's own budgets
      // (spawn preflight fetch bounds + the RR-3 root-tail backstop).
      const inFlight = inFlightMaterializeByKey.get(request.materializationKey);
      if (inFlight) await inFlight;
      const entry = releaseEntriesByKey.get(request.materializationKey) ?? null;
      // Unregister the run's OWN keyspace entry (keyed by its materialization key). The host session's
      // pid-keyed target is a different keyspace and is never touched by a run release.
      deps.runtimeRegistry?.unregisterRunKey(request.materializationKey);
      if (!entry) {
        logger.debug('[DAEMON RUN] Connected-service run released', {
          runId: request.runId,
          released: false,
          cleanupRan: false,
        });
        return { released: false };
      }
      const cleanupRan = entry.cleanupOnExit !== null;
      entry.cleanupPromise ??= Promise.resolve().then(async () => {
        await entry.cleanupOnExit?.();
      });
      try {
        await entry.cleanupPromise;
      } catch (error) {
        entry.cleanupPromise = null;
        logger.debug('[DAEMON RUN] Connected-service run released', {
          runId: request.runId,
          released: false,
          cleanupRan,
        });
        return { released: false };
      }
      if (releaseEntriesByKey.get(request.materializationKey) === entry) {
        releaseEntriesByKey.delete(request.materializationKey);
      }
      logger.debug('[DAEMON RUN] Connected-service run released', {
        runId: request.runId,
        released: true,
        cleanupRan,
      });
      return { released: true };
    },
  };
}

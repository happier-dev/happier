import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import type { ActionOperationDomainOwner, ActionOperationOwnerUpdate, ActionOperationScope, ActionOperationQueryScope } from '@/daemon/actionOperations/actionOperationTypes';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { createActionOperationSetupReview } from '@/daemon/actionOperations/actionOperationSetupReview';
import { parseActionOperationProgressUpdate } from '@/daemon/actionOperations/actionOperationProgress';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import type { ExecutionRunState } from './executionRunTypes';
import { isDeepStrictEqual } from 'node:util';

/** Shared projection of an existing Run or its pending native startup invocation. */
export function createExecutionRunProjectSetupProjection(input: Readonly<{
  runId: string;
  scope: ActionOperationScope;
  signal: AbortSignal;
  readBaseSnapshot(): Omit<ActionOperationSnapshotV1, 'revision'> | null;
  publish(): void;
}>) {
  let revision = 1;
  let observed: Pick<ActionOperationSnapshotV1, 'progress' | 'domainRef' | 'observation'> = {};
  let setupReview: ActionOperationSnapshotV1['setupReview'];
  const changed = () => { revision++; input.publish(); };
  const updateObserved = (update: ActionOperationOwnerUpdate) => {
    const progress = update.progress === undefined ? observed.progress
      : parseActionOperationProgressUpdate(update.progress) ?? undefined;
    const domainRef = update.domainRef ?? observed.domainRef;
    const observation = update.observation === undefined ? observed.observation : update.observation ?? undefined;
    if (isDeepStrictEqual(observed.progress, progress) && isDeepStrictEqual(observed.domainRef, domainRef)
      && isDeepStrictEqual(observed.observation, observation)) return;
    observed = { progress, domainRef, observation };
    changed();
  };
  const review = createActionOperationSetupReview({ signal: input.signal, publish(details) { setupReview = details; changed(); } });
  const context: ProjectSetupOperationContext = {
    signal: input.signal,
    actionRequestId: input.runId,
    operationAcceptance: { operationId: input.runId, actionId: 'execution.run.start', accept() {} },
    operationOwnerUpdate: { update: updateObserved },
    operationProgress: { update(progress) { updateObserved({ progress }); } },
    operationReview: review.operationReview,
  };
  return Object.freeze({ context, scope: input.scope, refresh: review.refresh, decide: review.decide,
    snapshot(base = input.readBaseSnapshot()): ActionOperationSnapshotV1 | null {
      if (!base) return null;
      const state = base.state;
      const progress = observed.progress;
      return { ...base, revision: revision + (state === 'running' ? 0 : 1),
        ...(progress ? { progress } : {}), ...(observed.domainRef ? { domainRef: observed.domainRef } : {}),
        ...(state === 'running' && setupReview ? { setupReview } : {}),
        ...(state === 'running' && observed.observation ? { observation: observed.observation } : {}) };
    },
  });
}

export type ExecutionRunProjectSetup = ReturnType<typeof createExecutionRunProjectSetupProjection>;

/** Both local and Session-transport readers project the same controller facts. */
export function projectExecutionRunSetupBase(run: Pick<ExecutionRunState, 'runId' | 'status' | 'startedAtMs' | 'finishedAtMs' | 'error'>,
  scope: ActionOperationScope): Omit<ActionOperationSnapshotV1, 'revision'> {
  const state = run.status === 'running' ? 'running' : run.status === 'cancelled' ? 'cancelled'
    : run.status === 'succeeded' ? 'succeeded' : 'failed';
  return { version: 1, operationId: run.runId, actionId: 'execution.run.start', state, scope,
    title: 'Start execution run', createdAt: run.startedAtMs, startedAt: run.startedAtMs,
    ...(state === 'running' ? {} : { settledAt: run.finishedAtMs ?? run.startedAtMs }),
    ...(run.error ? { error: { errorCode: run.error.code, error: run.error.message ?? run.error.code } } : {}),
    cancellation: 'supported' };
}

/** Full Run status remains a projection of the actual controller. */
export function createExecutionRunProjectSetup(input: Readonly<{
  runId: string;
  scope: ActionOperationScope;
  signal: AbortSignal;
  readRun(): ExecutionRunState | undefined;
  publish(): void;
}>) {
  return createExecutionRunProjectSetupProjection({ ...input, readBaseSnapshot() {
    const run = input.readRun();
    if (!run) return null;
    return projectExecutionRunSetupBase(run, input.scope);
  } });
}

export function createExecutionRunProjectSetupOperationOwner(input: Readonly<{
  runs: ReadonlyMap<string, ExecutionRunState>;
  stop(runId: string): Promise<{ ok: boolean }>;
  waitForChange(runId: string, signal?: AbortSignal): Promise<void>;
  subscribe(listener: (runId: string) => void): () => void;
}>): ActionOperationDomainOwner {
  return createExecutionRunProjectSetupProjectionOwner({ ...input,
    getSetup: id => input.runs.get(id)?.projectSetup,
    listIds: () => [...input.runs.keys()],
  });
}

/** Routes review decisions back to their retained producer; never starts a Run. */
export function createExecutionRunProjectSetupProjectionOwner(input: Readonly<{
  getSetup(id: string): ExecutionRunProjectSetup | undefined;
  /** A retained Session invocation reads lifecycle facts from its Run controller. */
  readSnapshot?(setup: ExecutionRunProjectSetup): Promise<ActionOperationSnapshotV1 | null>;
  listIds(): readonly string[];
  stop?(runId: string): Promise<{ ok: boolean }>;
  waitForChange(runId: string, signal?: AbortSignal): Promise<void>;
  subscribe(listener: (runId: string) => void): () => void;
}>): ActionOperationDomainOwner {
  const read = (scope: ActionOperationQueryScope, id: string) => {
    const setup = input.getSetup(id);
    return setup && setup.scope.accountId === scope.accountId && setup.scope.machineId === scope.machineId
      && (!scope.sessionId || setup.scope.sessionId === scope.sessionId) ? setup : null;
  };
  const snapshot = async (setup: ExecutionRunProjectSetup | null | undefined) =>
    setup ? input.readSnapshot ? await input.readSnapshot(setup) : setup.snapshot() : null;
  return {
    actionIds: ['execution.run.start'],
    async list(scope) { return (await Promise.all(input.listIds().map(id => snapshot(read(scope, id))))).flatMap(value => value ? [value] : []); },
    async get(scope, id) { return await snapshot(read(scope, id)); },
    async cancel(scope, id) {
      const current = await snapshot(read(scope, id));
      if (!current) return null;
      if (current.state !== 'running' && current.state !== 'accepted') return { kind: 'already_settled' };
      return input.stop ? await input.stop(id).then(result => ({ kind: result.ok ? 'requested' as const : 'unsupported' as const }))
        : { kind: 'unsupported' };
    },
    async refreshSetupReview(scope, id) { await read(scope, id)?.refresh(); },
    async decideSetupReview(scope, id, workspace, phase, decision) {
      const setup = read(scope, id);
      const current = await snapshot(setup);
      const target = current?.domainRef;
      if (!setup || !current?.setupReview || setup.context.signal.aborted || target?.kind !== 'projectCommand'
        || target.serverId !== workspace.serverId || target.machineId !== workspace.machineId || target.workspaceRefId !== workspace.workspaceId
        || normalizeWorkspaceRootPathV1(target.cwd) !== normalizeWorkspaceRootPathV1(workspace.rootPath)
        || (target.purpose === 'teardown' ? 'teardown' : 'setup') !== phase) return null;
      await setup.decide(decision);
      return await snapshot(setup);
    },
    async waitForTerminal(scope, id, signal, options) {
      while (true) {
        const current = await snapshot(read(scope, id));
        if (!current || current.state !== 'running' && current.state !== 'accepted' || options?.includeSetupReview && current.setupReview) return current;
        await input.waitForChange(id, signal);
      }
    },
    subscribe(subscriber) {
      return input.subscribe(id => { void subscriber.resolveScope().then(async scope => {
        const current = scope ? await snapshot(read(scope, id)) : null;
        if (current) subscriber.publishSnapshot(current);
      }).catch(() => undefined); });
    },
  };
}

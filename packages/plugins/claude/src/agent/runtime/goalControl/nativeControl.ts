import type {
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionGoalMutation,
  AgentSessionGoalMutationResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { CLAUDE_GOAL_WORK_STATE_ITEM_ID } from '../../transcripts/goalStatus.js';

export type ClaudeNativeGoalOperations = Readonly<{
  setGoal?(
    objective: string | undefined,
    options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
  ): Promise<unknown>;
  clearGoal?(): Promise<unknown>;
}>;

function diagnostic(code: string) {
  return { code, severity: 'error' as const, message: code };
}

function unsupported(code: string): AgentSessionGoalMutationResult {
  return { status: 'unsupported', diagnostic: diagnostic(code) };
}

function unavailable(code: string): AgentSessionGoalMutationResult {
  return {
    status: 'unavailable',
    retryable: true,
    diagnostic: diagnostic(code),
  };
}

function readObjective(mutation: AgentSessionGoalMutation): string | null {
  if (!('objective' in mutation) || typeof mutation.objective !== 'string') return null;
  const objective = mutation.objective.trim();
  return objective.length > 0 ? objective : null;
}

function requestsUnsupportedMutation(mutation: AgentSessionGoalMutation): boolean {
  return ('status' in mutation && mutation.status !== undefined)
    || ('tokenBudget' in mutation && mutation.tokenBudget !== undefined);
}

function readLiveFailure(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return record.ok === false && typeof record.errorCode === 'string'
    ? record.errorCode
    : null;
}

function publicationResult(
  result: Awaited<ReturnType<AgentSessionGoalControlContext['goalSource']['publish']>>,
): AgentSessionGoalMutationResult {
  if (result.status === 'applied' || result.status === 'unchanged') {
    return { status: result.status, revision: result.revision };
  }
  if (result.status === 'ignoredStale') {
    return { status: 'unchanged', revision: result.revision };
  }
  if (result.status === 'unavailable') {
    return unavailable(result.diagnostic.code);
  }
  if (result.status === 'conflict') {
    return {
      status: 'rejected',
      retryable: false,
      diagnostic: result.diagnostic,
    };
  }
  return unavailable('claude_goal_publication_unavailable');
}

export function createClaudeNativeGoalControl() {
  const liveOperations = new Map<string, ClaudeNativeGoalOperations>();
  const sourceSequences = new Map<string, number>();
  let operationOrdinal = 0;

  const nextSourceSequence = (sessionId: string): number => {
    const next = (sourceSequences.get(sessionId) ?? 0) + 1;
    sourceSequences.set(sessionId, next);
    return next;
  };
  const pending = (sessionId: string) => ({
    status: 'pending' as const,
    operationId: `claude-goal:${sessionId}:${++operationOrdinal}`,
  });

  const control: AgentSessionGoalControl = {
    async get(context) {
      return {
        status: 'unchanged',
        revision: `claude-goal:${context.session.id}:current`,
      };
    },
    async set(mutation, context, options) {
      if (requestsUnsupportedMutation(mutation)) {
        return unsupported('claude_goal_mutation_unsupported');
      }
      const objective = readObjective(mutation);
      if (!objective) return unsupported('claude_goal_objective_required');

      if (context.session.activity === 'active') {
        const operations = liveOperations.get(context.session.id);
        if (!operations?.setGoal) return unavailable('claude_goal_live_session_unavailable');
        const result = await operations.setGoal(objective, undefined);
        const failure = readLiveFailure(result);
        return failure ? unsupported(failure) : pending(context.session.id);
      }

      const observedAtMs = Date.now();
      return publicationResult(await context.goalSource.publish({
        sourceSequence: nextSourceSequence(context.session.id),
        observedAtMs,
        items: [{
          localId: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: objective,
          updatedAtMs: observedAtMs,
        }],
        primaryLocalId: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
      }, { signal: options?.signal }));
    },
    async clear(context, options) {
      if (context.session.activity === 'active') {
        const operations = liveOperations.get(context.session.id);
        if (!operations?.clearGoal) return unavailable('claude_goal_live_session_unavailable');
        const result = await operations.clearGoal();
        const failure = readLiveFailure(result);
        return failure ? unsupported(failure) : pending(context.session.id);
      }

      return publicationResult(await context.goalSource.publish({
        sourceSequence: nextSourceSequence(context.session.id),
        observedAtMs: Date.now(),
        items: [],
        primaryLocalId: null,
      }, { signal: options?.signal }));
    },
  };

  return Object.freeze({
    control,
    bind(sessionId: string, operations: ClaudeNativeGoalOperations) {
      liveOperations.set(sessionId, operations);
      return () => {
        if (liveOperations.get(sessionId) === operations) liveOperations.delete(sessionId);
      };
    },
  });
}

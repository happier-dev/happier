import {
  ACTION_IDS,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ActionId,
  type ActionExecutorDeps,
  type WorkflowRunStartedByV1,
  resolveWorkflowRunStartedByForActionCallerV1,
} from '@happier-dev/protocol';

import { requestDaemonPluginActionExecution } from '@/daemon/controlClient';
import type { PluginActionExecutionAttempt } from '@/plugins/runtime/invocation/actions/executeContributedAction';

type OccurrenceBoundActionExecutorContext = ActionExecutorContext & Readonly<{
  /** Host-stamped turn admission fence; never Action input or SDK surface. */
  expectedContributorOccurrenceId?: string;
}>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    context?: OccurrenceBoundActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
}>;
type PluginActionExecutor = ActionExecutorLike & Readonly<{
  invokeContributedAction: NonNullable<ActionExecutorDeps['invokeContributedAction']>;
}>;

const DAEMON_OWNED_PLUGIN_META_ACTION_IDS = new Set<string>([
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  'action.invoke',
]);
const BUILT_IN_ACTION_IDS = new Set<string>(ACTION_IDS);

/**
 * Extends an existing first-party executor with the daemon's final external
 * action owner. The daemon route acquires the current runtime-registry lease,
 * activates the owning plugin when needed, and enforces target-action policy.
 */
export function createDaemonPluginActionExecutor(params: Readonly<{
  base: ActionExecutorLike;
  requestPluginActionExecution?: PluginActionExecutionRequestOwner;
  /** Host-stamped descriptive starter; never an authorization principal. */
  startedBy?: WorkflowRunStartedByV1;
}>): PluginActionExecutor {
  return createPluginActionExecutor({
    base: params.base,
    requestPluginActionExecution: params.requestPluginActionExecution
      ?? requestDaemonPluginActionExecution,
    ...(params.startedBy ? { startedBy: params.startedBy } : {}),
  });
}

export type PluginActionExecutionRequestOwner = (request: Readonly<{
    actionId: string;
    input: unknown;
    surface: 'cli' | 'mcp' | 'agent';
    defaultSessionId?: string;
    /** Bounded host-stamped descriptive fact; never permission ancestry. */
    startedBy?: WorkflowRunStartedByV1;
    expectedContributorOccurrenceId?: string;
  }>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<PluginActionExecutionAttempt>;

/** Routes dynamic/meta Actions to one explicit execution owner before the built-in executor. */
export function createPluginActionExecutor(params: Readonly<{
  base: ActionExecutorLike;
  requestPluginActionExecution: PluginActionExecutionRequestOwner;
  /** Host-stamped descriptive fallback; an exact context caller takes precedence. */
  startedBy?: WorkflowRunStartedByV1;
}>): PluginActionExecutor {
  const requestContributed = async (
    actionId: string, input: unknown, context?: OccurrenceBoundActionExecutorContext,
  ) => {
    const surface: 'cli' | 'mcp' | 'agent' = context?.surface === 'mcp'
      ? 'mcp' : context?.surface === 'agent' ? 'agent' : 'cli';
    const startedBy = context?.actionCaller
      ? resolveWorkflowRunStartedByForActionCallerV1(context.actionCaller)
      : params.startedBy;
    const request = {
      actionId, input, surface,
      ...(startedBy ? { startedBy } : {}),
      ...(typeof context?.defaultSessionId === 'string' ? { defaultSessionId: context.defaultSessionId } : {}),
      ...(typeof context?.expectedContributorOccurrenceId === 'string'
        && context.expectedContributorOccurrenceId.trim().length > 0
        ? { expectedContributorOccurrenceId: context.expectedContributorOccurrenceId.trim() } : {}),
    };
    return context?.signal
      ? await params.requestPluginActionExecution(request, { signal: context.signal })
      : await params.requestPluginActionExecution(request);
  };
  return {
    invokeContributedAction: async (request) => {
      const attempt = await requestContributed('action.invoke', {
        action: request.action, input: request.input,
      }, { ...request.context, ...(request.signal ? { signal: request.signal } : {}) });
      // A nested invocation must never fall back to the same base Action owner.
      return attempt.matched ? attempt.result : {
        ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable',
      };
    },
    execute: async (actionId, input, context) => {
      const normalizedActionId = String(actionId);
      if (!BUILT_IN_ACTION_IDS.has(normalizedActionId)
        || DAEMON_OWNED_PLUGIN_META_ACTION_IDS.has(normalizedActionId)) {
        const attempt = await requestContributed(normalizedActionId, input, context);
        if (attempt.matched) {
          return attempt.result;
        }
      }
      return await params.base.execute(actionId, input, context);
    },
  };
}

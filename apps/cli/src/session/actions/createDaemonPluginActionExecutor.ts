import {
  ACTION_IDS,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ActionId,
} from '@happier-dev/protocol';

import { requestDaemonPluginActionExecution } from '@/daemon/controlClient';
import type { PluginActionExecutionAttempt } from '@/plugins/projection/actions/execute';

type GenerationBoundActionExecutorContext = ActionExecutorContext & Readonly<{
  /** Host-stamped turn admission fence; never Action input or SDK surface. */
  expectedContributorImmutableGenerationId?: string;
}>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    context?: GenerationBoundActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
}>;

const DAEMON_OWNED_PLUGIN_META_ACTION_IDS = new Set<string>([
  'action.spec.search',
  'action.spec.get',
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
  requestPluginActionExecution?: (request: Readonly<{
    actionId: string;
    input: unknown;
    surface: 'cli' | 'mcp' | 'agent';
    authority: NonNullable<ActionExecutorContext['authority']>;
    defaultSessionId?: string;
    expectedContributorImmutableGenerationId?: string;
  }>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<PluginActionExecutionAttempt>;
}>): ActionExecutorLike {
  const requestPluginActionExecution = params.requestPluginActionExecution
    ?? requestDaemonPluginActionExecution;
  return {
    execute: async (actionId, input, context) => {
      const normalizedActionId = String(actionId);
      if (!BUILT_IN_ACTION_IDS.has(normalizedActionId)
        || DAEMON_OWNED_PLUGIN_META_ACTION_IDS.has(normalizedActionId)) {
        const surface: 'cli' | 'mcp' | 'agent' = context?.surface === 'mcp'
          ? 'mcp'
          : context?.surface === 'agent'
            ? 'agent'
            : 'cli';
        const request = {
          actionId: normalizedActionId,
          input,
          surface,
          authority: context?.authority ?? 'account_automation',
          ...(typeof context?.defaultSessionId === 'string'
            ? { defaultSessionId: context.defaultSessionId }
            : {}),
          ...(typeof context?.expectedContributorImmutableGenerationId === 'string'
            && context.expectedContributorImmutableGenerationId.trim().length > 0
            ? {
                expectedContributorImmutableGenerationId:
                  context.expectedContributorImmutableGenerationId.trim(),
              }
            : {}),
        };
        const attempt = context?.signal
          ? await requestPluginActionExecution(request, { signal: context.signal })
          : await requestPluginActionExecution(request);
        if (attempt.matched) {
          return attempt.result;
        }
      }
      return await params.base.execute(actionId, input, context);
    },
  };
}

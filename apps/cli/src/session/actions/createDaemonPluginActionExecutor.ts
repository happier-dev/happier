import {
  ACTION_IDS,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ActionId,
} from '@happier-dev/protocol';

import { requestDaemonPluginActionExecution } from '@/daemon/controlClient';
import type { PluginActionExecutionAttempt } from '@/plugins/projection/actions/execute';

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
}>;

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
    defaultSessionId?: string;
  }>) => Promise<PluginActionExecutionAttempt>;
}>): ActionExecutorLike {
  const requestPluginActionExecution = params.requestPluginActionExecution
    ?? requestDaemonPluginActionExecution;
  return {
    execute: async (actionId, input, context) => {
      const normalizedActionId = String(actionId);
      if (!BUILT_IN_ACTION_IDS.has(normalizedActionId)) {
        const attempt = await requestPluginActionExecution({
          actionId: normalizedActionId,
          input,
          surface: context?.surface === 'mcp'
            ? 'mcp'
            : context?.surface === 'agent'
              ? 'agent'
              : 'cli',
          ...(typeof context?.defaultSessionId === 'string'
            ? { defaultSessionId: context.defaultSessionId }
            : {}),
        });
        if (attempt.matched) {
          return attempt.result;
        }
      }
      return await params.base.execute(actionId, input, context);
    },
  };
}

import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { executePluginActionIfAvailable } from '@/plugins/projection/actions/execute';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import {
  executeCliTranscriptAction,
  type CliTranscriptActionExecutorOptions,
} from './executeCliTranscriptAction';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0] & CliTranscriptActionExecutorOptions;

export function createCliActionExecutor(
  params: CliActionExecutorParams,
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  const base = createCliActionExecutorHarness(params).executor;
  const transcriptFollowLeaseRegistry = params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      maxLeases: 16,
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    });

  return {
    execute: async (actionId, input, context) => {
      const resolvedContext = {
        ...(context ?? {}),
        surface: context?.surface ?? 'cli',
      };
      const transcriptAction = await executeCliTranscriptAction({
        actionId,
        input,
        context: resolvedContext,
        defaultSessionId: params.sessionId,
        options: {
          ...params,
          transcriptFollowLeaseRegistry,
        },
      });
      if (transcriptAction) {
        return transcriptAction;
      }

      const pluginAction = await executePluginActionIfAvailable({
        happyHomeDir: params.happyHomeDir,
        actionId,
        input,
        context: {
          ...(typeof resolvedContext.defaultSessionId === 'string' ? { defaultSessionId: resolvedContext.defaultSessionId } : {}),
          surface: resolvedContext.surface === 'mcp' || resolvedContext.surface === 'session_agent'
            ? resolvedContext.surface
            : 'cli',
        },
      });
      if (pluginAction.matched) {
        return pluginAction.result;
      }

      return await base.execute(actionId, input, resolvedContext);
    },
  };
}

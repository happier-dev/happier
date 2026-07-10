import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { executePluginActionIfAvailable } from '@/plugins/projection/actions/execute';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import {
  executeCliTranscriptAction,
  type CliTranscriptActionExecutorOptions,
} from './executeCliTranscriptAction';
import { readActionsSettingsFromEnv } from '@/settings/actionsSettings';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0] & CliTranscriptActionExecutorOptions;

function readReviewEngineIds(actionId: string, input: unknown): readonly string[] {
  if (actionId !== 'review.start' || !input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  const engineIds = (input as Readonly<{ engineIds?: unknown }>).engineIds;
  if (!Array.isArray(engineIds)) {
    return [];
  }
  return Object.freeze(engineIds.flatMap((engineId) => (
    typeof engineId === 'string' && engineId.trim().length > 0 ? [engineId.trim()] : []
  )));
}

async function activateReviewProvidersForAction(params: Readonly<{
  happyHomeDir?: string;
  actionId: string;
  input: unknown;
}>): Promise<void> {
  const engineIds = readReviewEngineIds(params.actionId, params.input);
  if (engineIds.length === 0) {
    return;
  }
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: params.happyHomeDir,
    resolveRuntimeRegistry: async () => {
      const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
      return await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: params.happyHomeDir });
    },
  });
  try {
    await Promise.all([...new Set(engineIds)].sort().map((engineId) => (
      lease.registry.activatePluginsByEvent(`onReviewProvider:${engineId}`)
    )));
  } finally {
    await lease.release();
  }
}

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
        actionsSettings: readActionsSettingsFromEnv() as any,
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
          surface: resolvedContext.surface === 'mcp'
            ? 'mcp'
            : resolvedContext.surface === 'agent'
              ? 'agent'
              : 'cli',
        },
      });
      if (pluginAction.matched) {
        return pluginAction.result;
      }

      await activateReviewProvidersForAction({
        happyHomeDir: params.happyHomeDir,
        actionId,
        input,
      });

      return await base.execute(actionId, input, resolvedContext);
    },
  };
}

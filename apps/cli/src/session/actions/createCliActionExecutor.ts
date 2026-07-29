import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import {
  executeCliTranscriptAction,
  type CliTranscriptActionExecutorOptions,
} from './executeCliTranscriptAction';
import { readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { createCliApprovalsArtifactStore } from './approvals/artifactStore';
import { createTargetActionCurrentIntentAdapter } from './approvals/targetActionCurrentIntent';
import type { Credentials } from '@/persistence';
import { createDaemonPluginActionExecutor } from './createDaemonPluginActionExecutor';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0] & CliTranscriptActionExecutorOptions;

export function createCredentialedTargetActionCurrentIntent(
  credentials: Credentials,
): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
  const store = createCliApprovalsArtifactStore({ credentials });
  return createTargetActionCurrentIntentAdapter({
    create: (request) => store.targetActionApprovalsCreate({ request }),
    read: (artifactId) => store.targetActionApprovalsGet({ artifactId }),
  });
}

export function createCliActionExecutor(
  params: CliActionExecutorParams,
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  const base = createCliActionExecutorHarness(params).executor;
  const daemonAware = createDaemonPluginActionExecutor({ base });
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

      return await daemonAware.execute(actionId, input, resolvedContext);
    },
  };
}

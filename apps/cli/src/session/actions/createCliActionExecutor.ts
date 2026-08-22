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
import type { StoredCredentials } from '@/persistence';
import { createDaemonPluginActionExecutor } from './createDaemonPluginActionExecutor';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0]
  & CliTranscriptActionExecutorOptions
  & Readonly<{
    runtimeActionExecute?: RuntimeActionExecute;
    externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  }>;

export function createCredentialedTargetActionCurrentIntent(
  credentials: StoredCredentials,
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
  const transcriptFollowLeaseRegistry = params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      maxLeases: 16,
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    });
  const base = createCliActionExecutorHarness(
    params,
    {
      ...(params.runtimeActionExecute
        ? { runtimeActionExecute: params.runtimeActionExecute }
        : {}),
      sessionTranscriptAction: async ({ actionId, input, context }) => await executeCliTranscriptAction({
        actionId,
        input,
        context,
        defaultSessionId: params.sessionId,
        options: {
          ...params,
          transcriptFollowLeaseRegistry,
        },
      }),
    },
  ).executor;
  const daemonAware = createDaemonPluginActionExecutor({ base });
  return {
    execute: async (actionId, input, context) => {
      const resolvedContext = {
        ...(context ?? {}),
        surface: context?.surface ?? 'cli',
        actionsSettings: readActionsSettingsFromEnv() as any,
      };
      return await daemonAware.execute(actionId, input, resolvedContext);
    },
  };
}

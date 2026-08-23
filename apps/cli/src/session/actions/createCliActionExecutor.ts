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
import {
  hasStoredSessionCredentialProvenance,
  type StoredCredentials,
} from '@/persistence';
import { createDaemonPluginActionExecutor } from './createDaemonPluginActionExecutor';
import type { ActionExecutorDeps, RuntimeActionExecute } from '@happier-dev/protocol';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0]
  & CliTranscriptActionExecutorOptions
  & Readonly<{
    runtimeActionExecute?: RuntimeActionExecute;
    externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
    /** The committed plugin-runtime owner for the built-in `action.invoke` Action. */
    invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
    /** The exact daemon external-session RPC owner for host-stamped API requests. */
    hostExternalSessionAction?: ActionExecutorDeps['hostExternalSessionAction'];
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
      ...(params.invokeContributedAction
        ? { invokeContributedAction: params.invokeContributedAction }
        : {}),
      ...(params.hostExternalSessionAction
        ? { hostExternalSessionAction: params.hostExternalSessionAction }
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
  const resolveContext = (context: Parameters<typeof base.execute>[2]) => ({
    ...(context ?? {}),
    surface: context?.surface ?? 'cli',
    // API Tokens and unprovenanced synthetic credentials cannot assert that a
    // person is present merely by entering through the CLI surface.
    ...(hasStoredSessionCredentialProvenance(params.credentials)
      ? {}
      : { authority: 'account_automation' as const }),
    actionsSettings: readActionsSettingsFromEnv() as any,
  });
  return {
    prepare: async (actionId, input, context) => {
      const resolvedContext = resolveContext(context);
      return await base.prepare(actionId, input, resolvedContext);
    },
    execute: async (actionId, input, context) => {
      const resolvedContext = resolveContext(context);
      return await daemonAware.execute(actionId, input, resolvedContext);
    },
  };
}

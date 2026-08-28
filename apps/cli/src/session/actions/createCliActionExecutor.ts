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
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
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
import type { AccountServerActionDeps } from '@/api/accountServerActionDeps';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0]
  & CliTranscriptActionExecutorOptions
  & Readonly<{
    runtimeActionExecute?: RuntimeActionExecute;
    /** Current committed contributed Action declarations for catalog discovery. */
    listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
    externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
    /** The committed plugin-runtime owner for the built-in `action.invoke` Action. */
    invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
    /** Exact daemon replay for API target-action approvals. */
    targetActionApprovalReplay?: ActionExecutorDeps['targetActionApprovalReplay'];
    /** The exact daemon external-session RPC owner for host-stamped API requests. */
    hostExternalSessionAction?: ActionExecutorDeps['hostExternalSessionAction'];
    /** Thin adapters to the canonical Account-server-owned auth routes. */
    accountServerActionDeps?: AccountServerActionDeps;
    pluginActionExecutionOwner?: 'daemon_control' | 'current_process';
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
  const actionSettingsProvider = createActionSettingsProvider();
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
      ...(params.targetActionApprovalReplay
        ? { targetActionApprovalReplay: params.targetActionApprovalReplay }
        : {}),
      ...(params.listContributedActionDefinitions
        ? { listContributedActionDefinitions: params.listContributedActionDefinitions }
        : {}),
      ...(params.hostExternalSessionAction
        ? { hostExternalSessionAction: params.hostExternalSessionAction }
        : {}),
      ...(params.accountServerActionDeps ?? {}),
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
  const daemonAware = params.pluginActionExecutionOwner === 'current_process'
    ? base
    : createDaemonPluginActionExecutor({ base });
  const resolveContext = (context: Parameters<typeof base.execute>[2]) => ({
    ...(context ?? {}),
    surface: context?.surface ?? 'cli',
    // API Tokens and unprovenanced synthetic credentials cannot assert that a
    // person is present merely by entering through the CLI surface.
    ...(hasStoredSessionCredentialProvenance(params.credentials)
      ? {}
      : { authority: 'account_automation' as const }),
    actionsSettings: actionSettingsProvider.getActionsSettings(),
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

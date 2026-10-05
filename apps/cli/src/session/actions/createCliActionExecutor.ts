import { createSessionFollowActionDeps } from '@/api/sessionFollowActionDeps';
import { createSessionReadStateActionDeps } from '@/api/sessionReadStateActionDeps';
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
import { createCommittedInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import type { CliActionExactHomeTarget } from './createCliActionDeps';
import { clientActionUnavailable, type ActionExecutorContext, type ActionExecutorDeps, type RuntimeActionExecute } from '@happier-dev/protocol';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import type { AccountServerActionDeps } from '@/api/accountServerActionDeps';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { createSpawnConnectedServicesTeamResourceCatalogResolver } from '@/session/services/spawnConnectedServicesDefaults';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { resolveEffectiveTerminalPresentUserPolicy } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0]
  & CliTranscriptActionExecutorOptions
  & Readonly<{
    runtimeActionExecute?: RuntimeActionExecute;
    clientActionExecute?: ActionExecutorDeps['clientActionExecute'];
    /** Bound by the live Session/Run host; private and deferred operations retain Artifact custody. */
    sessionActionConfirmation?: ActionExecutorDeps['sessionActionConfirmation'];
    /** Current committed contributed Action declarations for catalog discovery. */
    listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
    inputTypeDeps?: Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>;
    externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
    /** The committed plugin-runtime owner for the built-in `action.invoke` Action. */
    invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
    /** Exact daemon replay for API target-action approvals. */
    targetActionApprovalReplay?: ActionExecutorDeps['targetActionApprovalReplay'];
    /** Current authority/credential/target proof for durable core Action replay. */
    isApprovalExecutionOriginCurrent?: ActionExecutorDeps['isApprovalExecutionOriginCurrent'];
    /** The exact daemon external-session RPC owner for host-stamped API requests. */
    hostExternalSessionAction?: ActionExecutorDeps['hostExternalSessionAction'];
    /** Thin adapters to the canonical Account-server-owned auth routes. */
    accountServerActionDeps?: AccountServerActionDeps;
    /** Origin-neutral workflow family handler; absent until its server/session owners are bound. */
    workflowAction?: ActionExecutorDeps['workflowAction'];
    sessionFollowActionDeps?: Pick<ActionExecutorDeps, 'sessionFollowAction'>;
    sessionTrackedTargetCompatibilityDeps?: Pick<ActionExecutorDeps, 'sessionTargetTrackedSet'>;
    sessionReadStateActionDeps?: Pick<ActionExecutorDeps, 'sessionReadStateAction'>;
    pluginActionExecutionOwner?: 'daemon_control' | 'current_process';
  }>;

export function createCredentialedTargetActionCurrentIntent(
  credentials: StoredCredentials,
): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
  const store = createCliApprovalsArtifactStore({ credentials });
  return async (currentIntent) => {
    const serverUrl = resolveServerHttpBaseUrl();
    return await runWithServerHttpBaseUrl(serverUrl, () => createTargetActionCurrentIntentAdapter({
      create: (request) => store.targetActionApprovalsCreate({ request }),
      read: (artifactId) => store.targetActionApprovalsGet({ artifactId }),
      subscribeChanges: (artifactId, onChange, onError) => observeAccountChanges({
        token: credentials.token,
        serverUrl,
        entityId: artifactId,
      }, { onChange, onError }),
    })(currentIntent));
  };
}

export function createCliActionExecutor(
  params: CliActionExecutorParams,
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  const invokeContributedAction: ActionExecutorDeps['invokeContributedAction'] = params.invokeContributedAction
    ?? (params.pluginActionExecutionOwner === 'current_process' ? undefined
      : async (request) => pluginExecutor!.invokeContributedAction(request));
  const actionSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
  });
  const runtimeAccountId = readAccountIdFromToken(params.token) ?? undefined;
  const transcriptFollowLeaseRegistry = params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      maxLeases: 16,
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    });
  const resolveTeamCredentialResourceCatalog = params.resolveTeamCredentialResourceCatalog
    ?? (runtimeAccountId && params.accountServerActionDeps?.homeDomainAction
      ? createSpawnConnectedServicesTeamResourceCatalogResolver({
          homeDomainAction: params.accountServerActionDeps.homeDomainAction,
          serverId: params.serverId ?? configuration.activeServerId,
          accountId: runtimeAccountId,
        })
      : undefined);
  // The exact Home pair travels to its owners as one value; spreading the two
  // fields separately loses the binding the params type already guarantees.
  const exactHome: CliActionExactHomeTarget =
    params.serverId !== undefined && params.serverHttpBaseUrl !== undefined
      ? { serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl }
      : {};
  const harness = createCliActionExecutorHarness(
    {
      ...params,
      actionsSettingsProvider: actionSettingsProvider,
      ...(resolveTeamCredentialResourceCatalog ? { resolveTeamCredentialResourceCatalog } : {}),
    },
    {
      ...(params.sessionActionConfirmation ? { sessionActionConfirmation: params.sessionActionConfirmation } : {}),
      clientActionExecute: params.clientActionExecute ?? (async ({ actionId }) => clientActionUnavailable(actionId)),
      ...(params.runtimeActionExecute
        ? { runtimeActionExecute: params.runtimeActionExecute }
        : {}),
      ...(invokeContributedAction
        ? { invokeContributedAction }
        : {}),
      ...(params.targetActionApprovalReplay
        ? { targetActionApprovalReplay: params.targetActionApprovalReplay }
        : {}),
      ...(params.isApprovalExecutionOriginCurrent
        ? { isApprovalExecutionOriginCurrent: params.isApprovalExecutionOriginCurrent }
        : {}),
      ...(params.listContributedActionDefinitions
        ? { listContributedActionDefinitions: params.listContributedActionDefinitions }
        : {}),
      ...(params.inputTypeDeps ?? (params.pluginActionExecutionOwner === 'current_process' ? createCommittedInputTypeDeps() : {})),
      ...(params.hostExternalSessionAction
        ? { hostExternalSessionAction: params.hostExternalSessionAction }
        : {}),
      ...(params.accountServerActionDeps ?? {}),
      ...(params.workflowAction ? { workflowAction: params.workflowAction } : {}),
      ...(params.sessionFollowActionDeps ?? createSessionFollowActionDeps({
        token: params.token,
        ...exactHome,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
        ...(params.credentials ? {
          prepareSourceKeyAfterSet: createSessionFollowSourceKeyPreparationAfterSet({
            credentials: params.credentials,
            ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
            ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
            ...(params.resolveServerFeaturesSnapshot
              ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
              : {}),
            ...(params.externalActionMachineRequestPrivateKey
              ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
              : {}),
            ...(params.externalActionMachineInstallationId
              ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
              : {}),
          }),
        } : {}),
      })),
      ...(params.sessionTrackedTargetCompatibilityDeps ?? {}),
      ...(params.sessionReadStateActionDeps ?? createSessionReadStateActionDeps({
        token: params.token,
        ...exactHome,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      })),
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
  );
  const base = harness.executor;
  const pluginExecutor = params.pluginActionExecutionOwner === 'current_process'
    ? null : createDaemonPluginActionExecutor({ base });
  const daemonAware = pluginExecutor ?? base;
  const resolveContext = (context: Parameters<typeof base.execute>[2]) => {
    const currentWorkspaceWrites = harness.deps.getCurrentWorkspaceWrites?.();
    const credential = params.credentials && hasStoredSessionCredentialProvenance(params.credentials) ? 'terminal' : 'api_token';
    const surface = context?.surface ?? 'cli';
    // RPC receivers already have the verified caller stamp. The host's terminal
    // opt-out cannot narrow an Account/UI caller; an unstamped RPC stays automation.
    const authority = surface === 'rpc'
      ? credential === 'terminal' ? context?.authority ?? 'account_automation' : 'account_automation'
      : context?.authority === 'account_automation' ? 'account_automation' : resolveInvocationAuthority({
        credential, surface,
        terminalPolicy: resolveEffectiveTerminalPresentUserPolicy({
          token: params.token,
          ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
        }),
      });
    return ({
    ...(context ?? {}),
    ...((currentWorkspaceWrites || context?.workspaceWrites) ? {
      workspaceWrites: currentWorkspaceWrites === 'deny' || context?.workspaceWrites === 'deny'
        ? 'deny' as const : currentWorkspaceWrites ?? context?.workspaceWrites,
    } : {}),
    surface,
    authority,
    // The authenticated runtime token, not a caller-supplied context field,
    // owns the Account portion of portable Agent spawn identity.
    ...(runtimeAccountId ? { runtimeAccountId } : {}),
    actionsSettings: actionSettingsProvider.getActionsSettings(),
    sessionAgentSpawnPolicyV1:
      context?.sessionAgentSpawnPolicyV1
      ?? actionSettingsProvider.getAccountSettings?.()?.sessionAgentSpawnPolicyV1,
    });
  };
  return {
    prepare: async (actionId, input, context) => {
      const resolvedContext = resolveContext(context);
      return await base.prepare(actionId, input, resolvedContext);
    },
    execute: async (actionId, input, context) => {
      const resolvedContext = resolveContext(context);
      return await daemonAware.execute(actionId, input, resolvedContext);
    },
    replayApprovedApprovalRequest: async (args) => await base.replayApprovedApprovalRequest(args),
  };
}

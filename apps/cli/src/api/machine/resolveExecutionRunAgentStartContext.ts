import { BackendTargetRefV2InputSchema, resolveBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentStartContextV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { actionStartTargetUnavailableV1, resolveRunStartModelAndConfig } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { roleEngineModelFieldsV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { ExecutionRunRpcHandlerContext } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';

/** Detached host starts use their admitted requester, without inventing a Session or Workflow caller. */
export function createMachineExecutionRunAgentStartContextResolver(input: Readonly<{
  machineId?: string;
  cwd: string;
}>): NonNullable<ExecutionRunRpcHandlerContext['resolveAgentStartContext']> {
  return async (context, _options, startInput) => {
    const requester = readRequesterAccountActionContext(context.callerInputAuthorization);
    const operation = requester?.savedSecretOperationContext ?? context.requesterSessionBootstrap?.savedSecretOperationContext;
    const serverUrl = requester?.serverHttpBaseUrl ?? context.requesterSessionBootstrap?.serverHttpBaseUrl;
    const snapshot = operation?.readSnapshot();
    if (!operation || !serverUrl || !snapshot?.scopeKey || !startInput) return null;
    const scopeKey = snapshot.scopeKey;
    const refuse = (reason: Parameters<typeof actionStartTargetUnavailableV1>[2]) =>
      actionStartTargetUnavailableV1(context, 'agent_start_context', reason);
    if (!input.machineId) return refuse('caller_machine_unavailable');
    const target = BackendTargetRefV2InputSchema.safeParse(startInput.backendTarget);
    if (!target.success) return refuse('caller_agent_unavailable');
    const roleId = startInput.roleId;
    if (typeof roleId !== 'string') return null;
    const ceiling = parseAgentPermissionIntentV1Alias(context.authority === 'present_user' ? 'yolo' : context.callerPermissionMode ?? 'default');
    if (!ceiling) return refuse('caller_permission_unavailable');
    const machineId = input.machineId;
    return await runWithServerHttpBaseUrl(serverUrl, async () => {
      const overrides = await prepareActiveAccountRoleOverrides({ credentials: operation.credentials,
        scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), operationContext: operation,
        signal: context.signal });
      if (overrides.status !== 'ready') return refuse('role_overrides_unavailable');
      const source = await createRoleSourceReader({ artifactStore: createCredentialedAccountArtifactStore(operation.credentials),
        accountId: readAccountIdFromToken(operation.credentials.token) ?? undefined,
        readRawAccountSettings: async () => snapshot.rawSettings ?? {},
      })(context.signal, { roleIds: [roleId] });
      if (source.status !== 'ready') return refuse('role_source_incomplete');
      const team = TeamCredentialProviderModelSelectionV1Schema.safeParse(startInput.teamCredentialModel);
      const model = ProviderBoundModelRefSchema.safeParse(startInput.modelSelection);
      const runOptions = resolveRunStartModelAndConfig(startInput);
      const selected = resolveRoleSelectionV1({ roleId, roleSourceInventory: source, settingsOverrides: overrides.overrides,
        defaultEngine: { agentTargetKey: resolveBackendTargetKeyV2(target.data),
          ...roleEngineModelFieldsV1(team.success ? { ...team.data, source: 'team_resource' } : model.success ? model.data : undefined),
          ...(!team.success && !model.success && runOptions.ok && runOptions.options.modelId ? { modelId: runOptions.options.modelId } : {}),
        } });
      return { caller: { kind: 'host' }, ...(context.authority === 'present_user' ? { initiator: 'user' } : {}),
        baseline: { machineId, directory: typeof startInput.cwd === 'string' ? startInput.cwd : input.cwd },
        roles: selected.ok ? { [roleId]: selected.selection } : {}, ledSubtreeSessionIds: [], callerPermissionCeiling: ceiling,
        workDepthLimit: snapshot.settings.workDepthLimit, allowLists: snapshot.settings.sessionAgentStartAllowListsV1 } satisfies AgentStartContextV1;
    });
  };
}

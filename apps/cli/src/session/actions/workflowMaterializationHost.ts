import { createWorkflowMaterializationHostV1 as createPortableWorkflowMaterializationHostV1, type WorkflowMaterializationHostDepsV1, type WorkflowMaterializationMachineTargetV1 } from '@happier-dev/protocol/actions/executor/workflowMaterializationHost';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import type { readAccountLaunchProfiles } from '@/settings/profiles/readProfilesFromAccountSettings';
import type { AiLaunchProfile, AccountSettings, materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import type { createRoleSourceReader, RoleSourceReader } from '@/session/roles/roleSources';
import type { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { WorkflowSessionConversation } from '@/daemon/workflows/sessionStepExecutor';

type Materialization = Pick<Parameters<typeof materializeWorkflowAcceptedSnapshotV1>[0], 'roleSelection' | 'effects'>;
type RoleSelection = NonNullable<Materialization['roleSelection']>;
type MachineTarget = WorkflowMaterializationMachineTargetV1;

function workflowMaterializationSourceUnavailable() {
  return createActionExecuteFailureError({ ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' });
}

/** Origin selection is a contextual fallback; Role and explicit engine overrides remain Protocol-owned. */
export function projectWorkflowConversationRoleSelection(origin: WorkflowSessionConversation, machineId: string): RoleSelection {
  const modelId = origin.runtimeSnapshot?.modelSelection?.value?.modelId;
  const sameMachine = origin.machineId === machineId;
  const teamModelSelection = sameMachine ? origin.runtimeSnapshot?.teamModelSelection : undefined;
  return {
    sessionRoles: origin.sessionRoles,
    ...(sameMachine && typeof origin.runtimeSelection?.profileId === 'string'
      ? { defaultProfileId: origin.runtimeSelection.profileId } : {}),
    defaultConnectedServices: sameMachine ? origin.runtimeSelection?.connectedServices : undefined,
    ...(teamModelSelection ? { defaultModelSelection: teamModelSelection } : {}),
    ...(origin.agentTarget ? { defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(origin.agentTarget),
      ...(modelId ? { modelId } : {}) } } : {}),
  };
}

export type WorkflowMaterializationHostDeps = Omit<WorkflowMaterializationHostDepsV1, 'readAuthorizedSession' | 'isHomeEquivalent'> & Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl?: string;
}>;

/** CLI boundary adapter for the shared exact-Machine materialization owner. */
export function createWorkflowMaterializationHostV1(deps: WorkflowMaterializationHostDeps) {
  return createPortableWorkflowMaterializationHostV1({ ...deps,
    readAuthorizedSession: async (sessionId, signal) => {
      const { resolveWorkflowAuthorizedSession } = await import('@/daemon/workflows/invocationRecoveryObserver');
      const read = () => resolveWorkflowAuthorizedSession({ credentials: deps.credentials, sessionId, ...(signal ? { signal } : {}) });
      const { runWithServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
      return deps.serverHttpBaseUrl ? runWithServerHttpBaseUrl(deps.serverHttpBaseUrl, read) : read();
    },
    isHomeEquivalent: async serverId => {
      const { isServerProfileHomeIdentity } = await import('@/server/serverProfiles');
      return deps.serverId ? isServerProfileHomeIdentity(deps.serverId, serverId) : false;
    },
  });
}

/** Shared opened Account sources for direct, trigger and definition admissions. */
export function createCredentialedWorkflowMaterializationHostV1(params: Omit<WorkflowMaterializationHostDeps,
  'readRoleSelection' | 'readLaunchProfile'> & Readonly<{
  credentials: StoredCredentials;
  accountId?: string;
  serverHttpBaseUrl?: string;
  readRoleSources?: RoleSourceReader;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
}>) {
  const artifactStore = createCredentialedAccountArtifactStore(params.credentials);
  return async (target: MachineTarget): Promise<Materialization & Readonly<{ agentStartPolicySnapshot: {
    policy: AccountSettings['sessionAgentSpawnPolicyV1']; workDepthLimit: AccountSettings['workDepthLimit'];
    allowLists: AccountSettings['sessionAgentStartAllowListsV1'];
  } }>> => {
    const resolve = async () => {
      target.signal?.throwIfAborted();
      const operation = params.savedSecretOperationContext;
      const [{ readAccountIdFromToken }, { bootstrapAccountSettingsContext }, { resolveAccountSettingsScopeKeyForToken }, { getActiveAccountSettingsSnapshotLifetimeToken, getActiveAccountSettingsSnapshot }, { createRoleSourceReader }, { runWithServerHttpBaseUrl }] = await Promise.all([import("@/cloud/decodeJwtPayload"), import("@/settings/accountSettings/bootstrapAccountSettingsContext"), import("@/settings/accountSettings/accountSettingsScopeKey"), import("@/settings/accountSettings/activeAccountSettingsSnapshot"), import("@/session/roles/roleSources"), import("@/api/client/serverHttpBaseUrl")]);
      const scopeKey = resolveAccountSettingsScopeKeyForToken(params.credentials.token);
      if (operation && (operation.credentials.token !== params.credentials.token || !await operation.isCurrent())) {
        throw workflowMaterializationSourceUnavailable();
      }
      const current = operation ? operation.readSnapshot()
        : await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking', refresh: 'force',
          honorAccountSettingsModeEnv: false });
      target.signal?.throwIfAborted();
      if (!current || current.source === 'none' || current.scopeKey !== scopeKey) throw workflowMaterializationSourceUnavailable();
      const roleAccount = { credentials: params.credentials,
        scopeKey, operationContext: operation,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), ...(target.signal ? { signal: target.signal } : {}) };
      const readSnapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
      const assertCurrent = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const { getActiveAccountSettingsSnapshotLifetimeToken } = await import("@/settings/accountSettings/activeAccountSettingsSnapshot");
        if (operation && !await operation.isCurrent() || readSnapshot()?.scopeKey !== scopeKey
          || !operation && getActiveAccountSettingsSnapshotLifetimeToken() !== roleAccount.lifetimeToken) {
          throw workflowMaterializationSourceUnavailable();
        }
      };
      const sourceReader = params.readRoleSources ?? createRoleSourceReader({ artifactStore,
        accountId: params.accountId ?? readAccountIdFromToken(params.credentials.token) ?? undefined,
        readRawAccountSettings: async () => {
          if (!current.rawSettings) throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'content_unavailable' });
          return current.rawSettings;
        },
      });
      let launchProfiles: ReturnType<typeof readAccountLaunchProfiles> | undefined;
      const readLaunchProfile = async (profileId: string) => {
        const { readAccountLaunchProfiles } = await import("@/settings/profiles/readProfilesFromAccountSettings");
        launchProfiles ??= readAccountLaunchProfiles(current.settings, params.credentials, target.signal, undefined, operation);
        const matching = (await launchProfiles).visibleProfiles.filter((candidate) => candidate.id === profileId);
        return matching.length === 1 && matching[0]!.enabled !== false ? matching[0]! : null;
      };
      const materialization = await createWorkflowMaterializationHostV1({ ...params,
        acpCatalogSnapshot: readSnapshot()?.acpCatalog,
        readAcpCatalog: async (signal) => {
          await assertCurrent(signal);
          const catalog = readSnapshot()?.acpCatalog;
          const { refreshActiveAcpCatalog } = await import("@/agent/acp/catalog/hydrateAcpCatalog");
          const prepared = catalog?.status === 'ready' ? catalog : await refreshActiveAcpCatalog({ credentials: params.credentials, signal, operationContext: operation });
          await assertCurrent(signal);
          return prepared;
        },
        callMachineAction: (input) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.callMachineAction(input)) : params.callMachineAction(input),
        ...(params.readHostActionContract ? { readHostActionContract: (actionId: string, machine: MachineTarget) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.readHostActionContract!(actionId, machine))
          : params.readHostActionContract!(actionId, machine) } : {}),
        readWorkflowDefinition: (ref, signal) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.readWorkflowDefinition(ref, signal))
          : params.readWorkflowDefinition(ref, signal),
        readRoleSelection: (roleId, signal) => {
          const read = async () => {
            await assertCurrent(signal);
            const roleSources = await sourceReader(signal, { roleIds: [roleId] });
            await assertCurrent(signal);
            // Open current Account overrides only when a Role is consumed.
            const { prepareActiveAccountRoleOverrides } = await import("@/settings/prompts/hydratePromptLibraryCatalog");
            const roleOverrides = await prepareActiveAccountRoleOverrides(roleAccount);
            await assertCurrent(signal);
            if (roleOverrides.status !== 'ready') throw Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable' });
            return { roleSourceInventory: roleSources, settingsOverrides: roleOverrides.overrides };
          };
          return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read();
        },
        readLaunchProfile: (profileId) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => readLaunchProfile(profileId)) : readLaunchProfile(profileId),
      })(target);
      return { ...materialization, agentStartPolicySnapshot: { policy: current.settings.sessionAgentSpawnPolicyV1,
        workDepthLimit: current.settings.workDepthLimit, allowLists: current.settings.sessionAgentStartAllowListsV1 } };
    };
    const { runWithServerHttpBaseUrl } = await import("@/api/client/serverHttpBaseUrl");
    return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, resolve) : resolve());
  };
}

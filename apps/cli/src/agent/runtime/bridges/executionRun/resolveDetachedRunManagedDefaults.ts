import { buildBackendTargetKeyV2, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { createPersonalSessionModelSelection, projectSessionModelRefToExecutionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { ManagedAgentSandboxContext } from '@happier-dev/protocol/teams/managedDefaults';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createCliManagedSessionDefaultsContextLoader } from '@/session/creation/cliManagedSessionDefaultsContext';
import { resolveSessionSpawnManagedDefaults } from '@/session/creation/resolveSessionSpawnManagedDefaults';
import { withSessionNativeSandbox } from '@/session/shared/sessionCreationCorrespondence';
import { createSpawnConnectedServicesTeamResourceCatalogResolver } from '@/session/services/spawnConnectedServicesDefaults';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { ExecutionRunManagerStartParams } from './executionRunTypes';
import { createExecutionRunCodedError } from './errors';
import { assertExecutionRunAgentDefaultChoice } from './runtime/openInputs';

/** A Run adapts its launch vocabulary; Session creation owns defaults and purpose selection. */
export async function resolveDetachedRunManagedDefaults(params: ExecutionRunManagerStartParams, host: Readonly<{
  machineId: string | null;
  agentSandbox: Pick<ManagedAgentSandboxContext, 'machineIsolation' | 'machineIsolationPolicy' | 'nativeSandboxAvailable'>;
}>) {
  const bootstrap = params.projectLaunchContext?.requester?.bootstrap;
  const requester = readRequesterAccountActionContext(params.projectLaunchContext?.ingress?.callerInputAuthorization);
  const credentials = bootstrap?.credentials ?? requester?.credentials ?? params.promptCredentials;
  const scope = credentials?.requesterSessionCredentialScope;
  const serverId = bootstrap?.attribution.serverId ?? scope?.serverId ?? params.requesterWorkAttributionV1?.serverId;
  const serverHttpBaseUrl = bootstrap?.serverHttpBaseUrl ?? requester?.serverHttpBaseUrl ?? scope?.serverHttpBaseUrl;
  const machineId = host.machineId ?? bootstrap?.attribution.machineId ?? params.requesterWorkAttributionV1?.machineId;
  if (!credentials || !serverId || !serverHttpBaseUrl || !machineId) {
    if (params.projectContext) throw createExecutionRunCodedError('project_requester_credentials_unavailable', 'Project defaults requester is unavailable');
    return null;
  }
  assertExecutionRunAgentDefaultChoice(params);
  const agentTarget = parseBackendTargetKeyV2(buildBackendTargetKeyV2(readBackendTargetRefV2(params.backendTarget)));
  if (agentTarget.kind !== 'agent') throw createExecutionRunCodedError('target_unavailable', 'Agent target is unavailable');
  const accountSettingsContext = bootstrap?.accountSettingsContext ?? requester?.accountSettingsContext;
  const loader = createCliManagedSessionDefaultsContextLoader({ credentials, serverId, serverHttpBaseUrl,
    ...(params.signal ? { signal: params.signal } : {}) });
  const home = createAccountServerActionDeps({ credentials, token: credentials.token, serverId, serverHttpBaseUrl });
  const accountId = readAccountIdFromToken(credentials.token);
  const explicitModel = params.modelSelection ? createPersonalSessionModelSelection(params.modelSelection, 0)
    : params.modelId ? { v: 1 as const, updatedAt: 0, ref: {
      agentTargetKey: buildBackendTargetKeyV2(agentTarget), providerConnectionId: null, modelId: params.modelId,
    } } : undefined;
  return runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
    const resolved = await resolveSessionSpawnManagedDefaults({
      executionTarget: { serverId, machineId }, agentTarget,
      ...(params.projectContext ? { projectContext: params.projectContext } : {}),
      ...(params.approvalProfileId === undefined ? {} : { approvalProfileId: params.approvalProfileId }),
      permissionMode: parseAgentPermissionIntentV1Alias(params.permissionMode) ?? undefined,
      ...(explicitModel ? { modelSelection: explicitModel } : {}),
      ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
      configuration: withSessionNativeSandbox(params.modelSelection === null || params.teamCredentialModel ? {
        mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0, selectionSource: 'explicit' },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      } : undefined, params.nativeSandbox),
    }, {
      agentId: readBackendTargetRefV2(params.backendTarget).backendId,
      accountSettings: accountSettingsContext?.rawSettings ?? accountSettingsContext?.settings ?? params.accountSettings,
      purposeCatalog: accountSettingsContext?.connectedPurposeCatalog,
      organizationPolicy: configuration.organizationPolicy,
      ...host.agentSandbox,
      readPersonalDefaults: loader.readPersonalDefaults, readSource: loader.readSource,
      readTeam: loader.readTeam, readHome: loader.readHome,
      ...(accountId && home.homeDomainAction ? { resolveTeamCredentialResourceCatalog:
        createSpawnConnectedServicesTeamResourceCatalogResolver({ homeDomainAction: home.homeDomainAction, serverId, accountId }) } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const model = resolved.modelSelection
      ? projectSessionModelRefToExecutionModelSelection(resolved.modelSelection.ref)
      : undefined;
    return { ...resolved, childSelection: undefined, modelSelection: model?.modelSelection,
      teamCredentialModel: model?.teamCredentialModel ?? params.teamCredentialModel };
  });
}

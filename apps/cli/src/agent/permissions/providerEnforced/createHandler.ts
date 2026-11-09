import type { ApiSessionClient } from '@/api/session/sessionClient';

import { ProviderEnforcedPermissionHandler } from './handler';
import type { PermissionRequestPushSender } from '../BasePermissionHandler';
import type { ToolNormalizationSourceV3 } from '@happier-dev/protocol/tools/v2/meta';
import type { AccountSettings, CodingPromptBehaviorV1 } from '@happier-dev/protocol';
import type { AgentStateRequestCoverageOptions } from '@happier-dev/agents';

export function createProviderEnforcedPermissionHandler(params: {
  session: ApiSessionClient;
  logPrefix: string;
  requestCoverage?: AgentStateRequestCoverageOptions;
  pushSender?: PermissionRequestPushSender | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  getCodingPromptBehavior?: (() => CodingPromptBehaviorV1 | null) | null;
  getWorkspaceWrites?: (() => 'allow' | 'deny' | undefined) | null;
  getMcpToolContext?: (() => import('@/mcp/runtime/resolveMcpToolIdentity').McpToolPolicyContext | null) | null;
  getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
  onAbortRequested?: (() => void | Promise<void>) | null;
  toolTrace?: (() => ToolNormalizationSourceV3 | null) | null;
  alwaysAutoApproveToolNameIncludes?: ReadonlyArray<string>;
  isMediatorPluginCurrent?: ((pluginId: string) => boolean) | null;
  isMediatorContributionCurrent?: ((mediator: Readonly<{
    pluginId: string;
    contributionLocalId: string;
  }>) => boolean) | null;
}): ProviderEnforcedPermissionHandler {
  return new ProviderEnforcedPermissionHandler(params.session, {
    logPrefix: params.logPrefix,
    ...('requestCoverage' in params ? { requestCoverage: params.requestCoverage } : {}),
    pushSender: params.pushSender ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
    getCodingPromptBehavior: params.getCodingPromptBehavior ?? null,
    getWorkspaceWrites: params.getWorkspaceWrites ?? null,
    getMcpToolContext: params.getMcpToolContext ?? null,
    getAccountSettingsSecretsReadKeys: params.getAccountSettingsSecretsReadKeys ?? null,
    onAbortRequested: params.onAbortRequested ?? null,
    toolTrace: params.toolTrace ?? null,
    alwaysAutoApproveToolNameIncludes: params.alwaysAutoApproveToolNameIncludes,
    isMediatorPluginCurrent: params.isMediatorPluginCurrent ?? null,
    isMediatorContributionCurrent: params.isMediatorContributionCurrent ?? null,
  });
}

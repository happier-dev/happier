import {
  DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
  DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema,
  type DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1,
  type DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1,
  type PluginContributionIdentityV1,
  type VoiceRawCredentialGrantDeclaration,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  createSelectedVoiceMachineClient,
  parseCredentialResponse,
  type SelectedVoiceMachineClientDeps,
  VoiceCredentialClientError,
} from './selectedMachineClient';
import { createPluginPermissionGrantActions } from '@/sync/domains/plugins/permissions/actions';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type SuccessfulInspect = Extract<
  DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1,
  Readonly<{ ok: true }>
>;
type SuccessfulRequest = Extract<
  DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1,
  Readonly<{ ok: true }>
>;

export class RawCredentialAuthorizationClient {
  private readonly machine;

  constructor(deps?: Partial<SelectedVoiceMachineClientDeps>) {
    this.machine = createSelectedVoiceMachineClient(deps);
  }

  async inspect(
    contribution: PluginContributionIdentityV1,
    rawGrant: VoiceRawCredentialGrantDeclaration,
    signal?: AbortSignal | null,
  ): Promise<SuccessfulInspect> {
    const response = parseCredentialResponse(
      DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
      await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT,
        { contribution, rawGrant },
        signal,
      ),
    );
    if (!response.ok) throw new VoiceCredentialClientError(response.errorCode);
    return response;
  }

  async request(
    contribution: PluginContributionIdentityV1,
    rawGrant: VoiceRawCredentialGrantDeclaration,
    signal?: AbortSignal | null,
  ): Promise<SuccessfulRequest> {
    const response = parseCredentialResponse(
      DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema,
      await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST,
        { contribution, rawGrant },
        signal,
      ),
    );
    if (!response.ok) throw new VoiceCredentialClientError(response.errorCode);
    return response;
  }
}

export const rawCredentialAuthorizationClient = new RawCredentialAuthorizationClient();

export async function inspectRawCredentialAuthorizationReadiness(
  contribution: PluginContributionIdentityV1,
  rawGrant: VoiceRawCredentialGrantDeclaration,
  signal?: AbortSignal,
  dependencies: Readonly<{
    client?: Pick<RawCredentialAuthorizationClient, 'inspect'>;
    list?: ReturnType<typeof createPluginPermissionGrantActions>['list'];
  }> = {},
): Promise<'ready' | 'approval_required' | 'unknown'> {
  try {
    const inspection = await (dependencies.client ?? rawCredentialAuthorizationClient)
      .inspect(contribution, rawGrant, signal);
    const authorization = inspection.authorization;
    const list = dependencies.list ?? createPluginPermissionGrantActions({
      execute: createFrontDoorUiActionExecutor(),
    }).list;
    const response = await list({
      pluginId: authorization.pluginId,
      capability: authorization.capability,
      targetScope: authorization.targetScope,
      subject: authorization.subject,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
    });
    const authorityKey = JSON.stringify(authorization.authoritySource);
    return response.grants.some((grant) => (
      grant.status === 'active'
      && JSON.stringify(grant.authoritySource) === authorityKey
    )) ? 'ready' : 'approval_required';
  } catch {
    return 'unknown';
  }
}

import {
  DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
  DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema,
  type DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1,
  type DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  createSelectedVoiceMachineClient,
  parseCredentialResponse,
  type SelectedVoiceMachineClientDeps,
  VoiceCredentialClientError,
} from './selectedMachineClient';

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
    signal?: AbortSignal | null,
  ): Promise<SuccessfulInspect> {
    const response = parseCredentialResponse(
      DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
      await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT,
        { contribution },
        signal,
      ),
    );
    if (!response.ok) throw new VoiceCredentialClientError(response.errorCode);
    return response;
  }

  async request(
    contribution: PluginContributionIdentityV1,
    signal?: AbortSignal | null,
  ): Promise<SuccessfulRequest> {
    const response = parseCredentialResponse(
      DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema,
      await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST,
        { contribution },
        signal,
      ),
    );
    if (!response.ok) throw new VoiceCredentialClientError(response.errorCode);
    return response;
  }
}

export const rawCredentialAuthorizationClient = new RawCredentialAuthorizationClient();

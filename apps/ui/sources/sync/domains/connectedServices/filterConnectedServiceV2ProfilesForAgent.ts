import {
  filterConnectedServiceV2ProfilesForAgent as filterConnectedServiceV2ProfilesForAgentShared,
  isConnectedServiceProfileKindSupportedForAgent as isConnectedServiceProfileKindSupportedForAgentShared,
  type AgentCore,
  type ConnectedServiceId,
  type ConnectedServiceKind,
} from '@happier-dev/agents';

type ConnectedServiceV2ProfileProjection = Readonly<{
  profileId: string;
  status: 'connected' | 'needs_reauth';
  kind?: ConnectedServiceKind | null;
  providerEmail?: string | null;
}>;

export function filterConnectedServiceV2ProfilesForAgent(params: Readonly<{
  agentCore: Pick<AgentCore, 'connectedServices'> | null;
  serviceId: ConnectedServiceId;
  profiles: ReadonlyArray<ConnectedServiceV2ProfileProjection>;
}>): ReadonlyArray<ConnectedServiceV2ProfileProjection> {
  return filterConnectedServiceV2ProfilesForAgentShared(params) as ReadonlyArray<ConnectedServiceV2ProfileProjection>;
}

export function isConnectedServiceProfileKindSupportedForAgent(params: Readonly<{
  agentCore: Pick<AgentCore, 'connectedServices'> | null;
  serviceId: ConnectedServiceId;
  kind: ConnectedServiceKind | null;
}>): boolean {
  return isConnectedServiceProfileKindSupportedForAgentShared(params);
}

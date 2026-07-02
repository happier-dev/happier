import type { AgentCore, ConnectedServiceId, ConnectedServiceKind } from '@happier-dev/agents';

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
  return params.profiles.filter((profile) => isConnectedServiceProfileKindSupportedForAgent({
    agentCore: params.agentCore,
    serviceId: params.serviceId,
    kind: profile.kind ?? null,
  }));
}

export function isConnectedServiceProfileKindSupportedForAgent(params: Readonly<{
  agentCore: Pick<AgentCore, 'connectedServices'> | null;
  serviceId: ConnectedServiceId;
  kind: ConnectedServiceKind | null;
}>): boolean {
  const allowedKinds = params.agentCore?.connectedServices?.supportedKindsByServiceId?.[params.serviceId];
  if (!Array.isArray(allowedKinds) || allowedKinds.length === 0) return true;
  if (!params.kind) return true;

  const allowed = new Set<ConnectedServiceKind>(allowedKinds);
  return allowed.has(params.kind);
}

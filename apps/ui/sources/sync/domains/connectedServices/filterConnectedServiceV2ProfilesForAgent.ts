import type { AgentCore, ConnectedServiceId, ConnectedServiceKind } from '@happier-dev/agents';

type ConnectedServiceV2ProfileProjection = Readonly<{
  profileId: string;
  status: 'connected' | 'needs_reauth';
  kind?: ConnectedServiceKind | null;
  providerEmail?: string | null;
}>;

export function filterConnectedServiceV2ProfilesForAgent(params: Readonly<{
  agentCore: AgentCore | null;
  serviceId: ConnectedServiceId;
  profiles: ReadonlyArray<ConnectedServiceV2ProfileProjection>;
}>): ReadonlyArray<ConnectedServiceV2ProfileProjection> {
  const allowedKinds = params.agentCore?.connectedServices?.supportedKindsByServiceId?.[params.serviceId];
  if (!Array.isArray(allowedKinds) || allowedKinds.length === 0) return params.profiles;

  const allowed = new Set<ConnectedServiceKind>(allowedKinds);
  return params.profiles.filter((profile) => {
    const kind = profile.kind ?? null;
    if (!kind) return true;
    return allowed.has(kind);
  });
}


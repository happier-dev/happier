import type {
  LinkedExternalSessionV1,
  PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { buildLinkedExternalSessionQualifiedIdentityV1 } from '@happier-dev/protocol';

export type CurrentExternalSessionAgentIdentity = Readonly<{
  identity: PluginContributionIdentityV1;
  sourceKinds: readonly string[];
}>;

export type LinkedExternalSessionQualifiedIdentityResolution =
  | Readonly<{
      ok: true;
      link: LinkedExternalSessionV1;
      writeForwardRequired: boolean;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'agent_unavailable';
      error: string;
    }>;

function isSameContributionIdentity(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

export async function resolveLinkedExternalSessionQualifiedIdentity(
  link: LinkedExternalSessionV1,
  deps: Readonly<{
    resolveCurrentAgent(agentId: string): Promise<CurrentExternalSessionAgentIdentity | null>;
  }>,
): Promise<LinkedExternalSessionQualifiedIdentityResolution> {
  const currentAgent = await deps.resolveCurrentAgent(link.agentId);
  if (!currentAgent) {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_agent_unavailable',
    };
  }

  if (
    link.qualifiedIdentity
    && !isSameContributionIdentity(link.qualifiedIdentity.agent, currentAgent.identity)
  ) {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_qualified_agent_unavailable',
    };
  }

  if (!currentAgent.sourceKinds.includes(link.source.kind)) {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_source_contract_unavailable',
    };
  }

  if (link.qualifiedIdentity) {
    return {
      ok: true,
      link,
      writeForwardRequired: false,
    };
  }

  return {
    ok: true,
    link: {
      ...link,
      qualifiedIdentity: buildLinkedExternalSessionQualifiedIdentityV1({
        agent: currentAgent.identity,
        sourceKind: link.source.kind,
      }),
    },
    writeForwardRequired: true,
  };
}

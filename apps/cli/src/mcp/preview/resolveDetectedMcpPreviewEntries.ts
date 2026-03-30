import type { DetectedMcpPreviewEntryV1, DetectedMcpServerV1 } from '@happier-dev/protocol';

function resolvePreviewProviderScopeKind(sourceKind: DetectedMcpServerV1['source']['kind']): 'providerUser' | 'providerProject' {
  return sourceKind === 'project' ? 'providerProject' : 'providerUser';
}

function resolveAgentDetectedProvider(agentId: string): DetectedMcpServerV1['provider'] | null {
  switch (agentId) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    default:
      return null;
  }
}

function countHeaderKeys(server: DetectedMcpServerV1): number {
  return server.remote?.headers?.length ?? 0;
}

function resolveDetectedAuthMode(server: DetectedMcpServerV1): DetectedMcpPreviewEntryV1['authMode'] {
  return server.envKeys.length > 0 || countHeaderKeys(server) > 0 ? 'unknown' : 'none';
}

export function resolveDetectedMcpPreviewEntries(params: Readonly<{
  agentId: string;
  servers: ReadonlyArray<DetectedMcpServerV1>;
}>): DetectedMcpPreviewEntryV1[] {
  const provider = resolveAgentDetectedProvider(params.agentId);
  if (!provider) return [];

  const filtered = params.servers.filter((server) => server.provider === provider);
  const winnersByName = new Map<string, DetectedMcpServerV1>();
  for (const server of filtered) {
    winnersByName.set(server.name, server);
  }

  const entries: DetectedMcpPreviewEntryV1[] = [];
  for (const server of winnersByName.values()) {
    if (server.enabled === false) continue;
    entries.push({
      key: `detected:${server.provider}:${server.name}`,
      name: server.name,
      transport: server.transport,
      authMode: resolveDetectedAuthMode(server),
      selected: true,
      selectable: false,
      availability: 'readOnly',
      sourceKind: 'detected',
      scopeKind: resolvePreviewProviderScopeKind(server.source.kind),
      provider: server.provider,
      enabled: server.enabled,
      envKeyCount: server.envKeys.length,
      headerKeyCount: countHeaderKeys(server),
      sourcePath: server.source.path,
    });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

import {
  decideCodexLocalControlSupport,
  type CodexLocalControlSupportDecision,
} from './localControlSupport';

type CreateCodexLocalControlSupportResolverParams = Readonly<{
  startedBy: 'daemon' | 'cli';
  experimentalCodexAcpEnabled: boolean;
  hasTtyForLocal?: boolean;
}>;

export function createCodexLocalControlSupportResolver(
  params: CreateCodexLocalControlSupportResolverParams,
): (opts: { includeAcpProbe: boolean }) => Promise<CodexLocalControlSupportDecision> {
  let localControlSupportCache: CodexLocalControlSupportDecision | null = null;

  return async (_opts: { includeAcpProbe: boolean }): Promise<CodexLocalControlSupportDecision> => {
    if (localControlSupportCache) return localControlSupportCache;

    const decision = decideCodexLocalControlSupport({
      startedBy: params.startedBy,
      experimentalCodexAcpEnabled: params.experimentalCodexAcpEnabled,
      hasTtyForLocal: params.hasTtyForLocal,
    });

    // No runtime probes; decision is always stable.
    localControlSupportCache = decision;

    return decision;
  };
}

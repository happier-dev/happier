import {
  decideCodexLocalControlSupport,
  type CodexLocalControlBackend,
  type CodexLocalControlSupportDecision,
} from './localControlSupport';

type CreateCodexLocalControlSupportResolverParams = Readonly<{
  startedBy: 'daemon' | 'cli';
  experimentalCodexAcpEnabled: boolean | (() => boolean);
  localControlBackend?: CodexLocalControlBackend | null | (() => CodexLocalControlBackend | null);
  hasTtyForLocal?: boolean;
}>;

export function createCodexLocalControlSupportResolver(
  params: CreateCodexLocalControlSupportResolverParams,
): (opts: { includeAcpProbe: boolean }) => Promise<CodexLocalControlSupportDecision> {
  const resolveBoolean = (value: boolean | (() => boolean)): boolean => {
    return typeof value === 'function' ? Boolean(value()) : Boolean(value);
  };
  const resolveBackend = (
    value: CodexLocalControlBackend | null | undefined | (() => CodexLocalControlBackend | null),
  ): CodexLocalControlBackend | null => {
    if (typeof value === 'function') return value() ?? null;
    return value ?? null;
  };

  return async (_opts: { includeAcpProbe: boolean }): Promise<CodexLocalControlSupportDecision> => {
    const decision = decideCodexLocalControlSupport({
      startedBy: params.startedBy,
      experimentalCodexAcpEnabled: resolveBoolean(params.experimentalCodexAcpEnabled),
      localControlBackend: resolveBackend(params.localControlBackend),
      hasTtyForLocal: params.hasTtyForLocal,
    });
    return decision;
  };
}

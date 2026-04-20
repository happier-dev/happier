import {
  decideCodexTerminalRuntimeSupport,
  type CodexTerminalRuntimeBackend,
  type CodexTerminalRuntimeSupportDecision,
} from './terminalRuntimeSupport';

type CreateCodexTerminalRuntimeSupportResolverParams = Readonly<{
  startedBy: 'daemon' | 'cli';
  experimentalCodexAcpEnabled: boolean | (() => boolean);
  terminalRuntimeBackend?: CodexTerminalRuntimeBackend | null | (() => CodexTerminalRuntimeBackend | null);
  hasTtyForTerminal?: boolean;
}>;

export function createCodexTerminalRuntimeSupportResolver(
  params: CreateCodexTerminalRuntimeSupportResolverParams,
): (opts: { includeAcpProbe: boolean }) => Promise<CodexTerminalRuntimeSupportDecision> {
  const resolveBoolean = (value: boolean | (() => boolean)): boolean => {
    return typeof value === 'function' ? Boolean(value()) : Boolean(value);
  };
  const resolveBackend = (
    value: CodexTerminalRuntimeBackend | null | undefined | (() => CodexTerminalRuntimeBackend | null),
  ): CodexTerminalRuntimeBackend | null => {
    if (typeof value === 'function') return value() ?? null;
    return value ?? null;
  };

  return async (_opts: { includeAcpProbe: boolean }): Promise<CodexTerminalRuntimeSupportDecision> => {
    const decision = decideCodexTerminalRuntimeSupport({
      startedBy: params.startedBy,
      experimentalCodexAcpEnabled: resolveBoolean(params.experimentalCodexAcpEnabled),
      terminalRuntimeBackend: resolveBackend(params.terminalRuntimeBackend),
      hasTtyForTerminal: params.hasTtyForTerminal,
    });
    return decision;
  };
}

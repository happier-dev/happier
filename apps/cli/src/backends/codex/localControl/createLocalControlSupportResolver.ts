import { probeCodexAcpLoadSessionSupport } from '@/backends/codex/acp/probeLoadSessionSupport';

import {
  decideCodexLocalControlSupport,
  type CodexLocalControlSupportDecision,
} from './localControlSupport';

type CreateCodexLocalControlSupportResolverParams = Readonly<{
  startedBy: 'daemon' | 'cli';
  experimentalCodexAcpEnabled: boolean;
  experimentalCodexResumeEnabled: boolean;
}>;

type ProbeAcpLoadSessionSupport = () => Promise<{ ok: boolean; loadSession?: boolean }>;

export function createCodexLocalControlSupportResolver(
  params: CreateCodexLocalControlSupportResolverParams,
  deps?: Readonly<{
    probeAcpLoadSessionSupport?: ProbeAcpLoadSessionSupport;
  }>,
): (opts: { includeAcpProbe: boolean }) => Promise<CodexLocalControlSupportDecision> {
  let localControlSupportCache: CodexLocalControlSupportDecision | null = null;
  let acpLoadSessionSupportedCache: boolean | null = null;

  const probeAcpLoadSessionSupport = deps?.probeAcpLoadSessionSupport ?? probeCodexAcpLoadSessionSupport;

  return async (opts: { includeAcpProbe: boolean }): Promise<CodexLocalControlSupportDecision> => {
    if (localControlSupportCache) return localControlSupportCache;

    const acpLoadSessionSupported = await (async () => {
      if (!params.experimentalCodexAcpEnabled) return false;
      if (!opts.includeAcpProbe) {
        // Fast-start: do not block local mode on a potentially-slow ACP probe.
        // If we already have a cached result from a prior probe, honor it.
        // Otherwise, optimistically assume support and verify later when needed.
        return typeof acpLoadSessionSupportedCache === 'boolean' ? acpLoadSessionSupportedCache : true;
      }
      if (typeof acpLoadSessionSupportedCache === 'boolean') return acpLoadSessionSupportedCache;
      const probe = await probeAcpLoadSessionSupport();
      acpLoadSessionSupportedCache = probe.ok ? probe.loadSession === true : false;
      return acpLoadSessionSupportedCache;
    })();

    const decision = decideCodexLocalControlSupport({
      startedBy: params.startedBy,
      experimentalCodexAcpEnabled: params.experimentalCodexAcpEnabled,
      experimentalCodexResumeEnabled: params.experimentalCodexResumeEnabled,
      acpLoadSessionSupported,
    });

    // Cache only when we have a stable answer:
    // - MCP path does not depend on ACP probe.
    // - ACP path should cache only after probing.
    if (!params.experimentalCodexAcpEnabled || typeof acpLoadSessionSupportedCache === 'boolean') {
      localControlSupportCache = decision;
    }

    return decision;
  };
}

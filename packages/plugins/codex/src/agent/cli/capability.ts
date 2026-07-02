export const codexCliCapabilityDescriptor = {
  id: 'cli.codex',
  kind: 'cli',
  title: 'Codex CLI',
} as const;

export type CodexCliAcpLoadSessionProbe =
  | Readonly<{
      ok: true;
      checkedAt: number;
      loadSession: boolean;
      agentCapabilities: unknown;
    }>
  | Readonly<{
      ok: false;
      checkedAt: number;
      error: unknown;
    }>;

export function shouldIncludeCodexAcpCapabilities(params: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return params?.includeAcpCapabilities === true;
}

export function buildCodexCliAcpCapabilitySnapshot(probe: CodexCliAcpLoadSessionProbe): Readonly<Record<string, unknown>> {
  if (probe.ok) {
    return {
      ok: true,
      checkedAt: probe.checkedAt,
      loadSession: probe.loadSession,
      agentCapabilities: probe.agentCapabilities,
    };
  }

  return {
    ok: false,
    checkedAt: probe.checkedAt,
    error: probe.error,
  };
}

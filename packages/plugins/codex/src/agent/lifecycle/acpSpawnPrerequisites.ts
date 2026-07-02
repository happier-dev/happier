export type CodexAcpSpawnPrerequisiteFailure = Readonly<{
  ok: false;
  reasonCode: 'codex_acp_unavailable';
  errorMessage: string;
}>;

export function resolveCodexAcpSpawnPrerequisiteFailure(params: Readonly<{
  command?: string | null;
  availabilityErrorMessage?: string | null;
  resolveErrorMessage?: string | null;
}>): CodexAcpSpawnPrerequisiteFailure {
  if (params.resolveErrorMessage) {
    return {
      ok: false,
      reasonCode: 'codex_acp_unavailable',
      errorMessage: params.resolveErrorMessage,
    };
  }

  if (params.command === 'codex-acp') {
    return {
      ok: false,
      reasonCode: 'codex_acp_unavailable',
      errorMessage:
        'Codex ACP is enabled, but codex-acp could not be resolved. Install codex-acp from the Happier app (Machine details -> Installables), add codex-acp to PATH, or switch Codex backend mode to app-server.',
    };
  }

  return {
    ok: false,
    reasonCode: 'codex_acp_unavailable',
    errorMessage: params.availabilityErrorMessage
      ? `Codex ACP is enabled, but ${params.availabilityErrorMessage.toLowerCase()}`
      : 'Codex ACP is enabled, but the command could not be resolved.',
  };
}

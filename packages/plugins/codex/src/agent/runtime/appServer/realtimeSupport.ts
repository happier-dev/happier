export const CODEX_REALTIME_CONVERSATION_SUPPORTED_CLI_VERSIONS = Object.freeze([
  '0.145.0',
  '0.146.0',
] as const);

export function isCodexRealtimeConversationCliVersionSupported(
  version: string | null | undefined,
): boolean {
  return typeof version === 'string'
    && CODEX_REALTIME_CONVERSATION_SUPPORTED_CLI_VERSIONS.some(
      (supportedVersion) => supportedVersion === version,
    );
}

export function buildOpenCodeProviderSessionMessageKey(providerSessionId: string, messageId: string): string {
  return `${encodeURIComponent(providerSessionId)}:${encodeURIComponent(messageId)}`;
}

export function buildOpenCodeRuntimeTranscriptLocalId(providerSessionId: string, messageId: string): string {
  return `opencode:${buildOpenCodeProviderSessionMessageKey(providerSessionId, messageId)}`;
}

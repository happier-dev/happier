function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function hasClaudeVendorResumeContinuityProof(metadata: unknown): boolean {
  const transcriptPath = asRecord(metadata)?.claudeTranscriptPath;
  return typeof transcriptPath === 'string' && transcriptPath.trim().length > 0;
}

export type ClaudeEffectiveModelEvidence = Readonly<{
  modelId: string;
  displayName?: string | null;
  contextWindowTokens?: number | null;
}>;

export type ClaudeEffectiveModelEvidenceSubscription = (
  listener: (evidence: ClaudeEffectiveModelEvidence) => void,
) => () => void;

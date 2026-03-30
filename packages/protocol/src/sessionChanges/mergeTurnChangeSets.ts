import type {
  ChangeConfidence,
  ChangeEvidenceSource,
  FileChangeEvidence,
  SessionChangeSet,
  SessionChangeSetFile,
  TurnChangeSet,
} from './types.js';

const SOURCE_PRECEDENCE: Record<ChangeEvidenceSource, number> = {
  provider_native: 0,
  provider_tool: 1,
  canonical_diff_tool: 2,
  canonical_patch_tool: 3,
  scm_reconciled: 4,
  inferred: 5,
};

const CONFIDENCE_PRECEDENCE: Record<ChangeConfidence, number> = {
  exact: 0,
  strong: 1,
  best_effort: 2,
};

function pickMoreSpecificSource(left: ChangeEvidenceSource, right: ChangeEvidenceSource): ChangeEvidenceSource {
  return SOURCE_PRECEDENCE[left] <= SOURCE_PRECEDENCE[right] ? left : right;
}

function pickWeakerConfidence(left: ChangeConfidence, right: ChangeConfidence): ChangeConfidence {
  return CONFIDENCE_PRECEDENCE[left] >= CONFIDENCE_PRECEDENCE[right] ? left : right;
}

function mergeFileEvidence(current: SessionChangeSetFile | null, next: FileChangeEvidence, turnId: string): SessionChangeSetFile {
  if (!current) {
    return {
      ...next,
      turns: [turnId],
    };
  }

  return {
    ...current,
    previousFilePath: current.previousFilePath ?? next.previousFilePath ?? null,
    changeKind: next.changeKind,
    unifiedDiff: next.unifiedDiff ?? current.unifiedDiff ?? null,
    oldText: current.oldText ?? next.oldText ?? null,
    newText: next.newText ?? current.newText ?? null,
    binary: current.binary ?? next.binary,
    source: pickMoreSpecificSource(current.source, next.source),
    confidence: pickWeakerConfidence(current.confidence, next.confidence),
    provider: next.provider || current.provider,
    providerTurnId: next.providerTurnId ?? current.providerTurnId ?? null,
    providerMessageId: next.providerMessageId ?? current.providerMessageId ?? null,
    description: next.description ?? current.description ?? null,
    turns: current.turns.includes(turnId) ? current.turns : [...current.turns, turnId],
  };
}

export function mergeTurnChangeSets(params: Readonly<{
  sessionId: string;
  turns: readonly TurnChangeSet[];
  rolledBackTurnIds?: readonly string[];
}>): SessionChangeSet {
  const byFilePath = new Map<string, SessionChangeSetFile>();
  let summarySource: ChangeEvidenceSource = 'provider_native';
  let summaryConfidence: ChangeConfidence = 'exact';

  for (const turn of params.turns) {
    for (const file of turn.files) {
      byFilePath.set(file.filePath, mergeFileEvidence(byFilePath.get(file.filePath) ?? null, file, turn.turnId));
      summarySource = pickMoreSpecificSource(summarySource, file.source);
      summaryConfidence = pickWeakerConfidence(summaryConfidence, file.confidence);
    }
  }

  return {
    sessionId: params.sessionId,
    turns: [...params.turns],
    files: Array.from(byFilePath.values()).sort((left, right) => left.filePath.localeCompare(right.filePath)),
    rolledBackTurnIds: [...(params.rolledBackTurnIds ?? [])],
    confidenceSummary: {
      source: summarySource,
      confidence: summaryConfidence,
    },
  };
}

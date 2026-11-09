import { normalizeCheckpointAttributionScope } from './checkpointAttributionScope.js';
import { normalizeRepositoryFilePath } from './reconcileWithScmSnapshot.js';
import type {
  ChangeConfidence,
  ChangeEvidenceSource,
  CheckpointOverlapObservation,
  FileChangeEvidence,
  SessionAttributionConfidence,
  SessionAttributionReason,
  SessionChangeAttribution,
  SessionChangeSet,
  SessionChangeSetFile,
  TurnChangeSet,
} from './types.js';

const SOURCE_PRECEDENCE: Record<ChangeEvidenceSource, number> = {
  scm_checkpoint: 0,
  scm_reconciled: 1,
  canonical_patch_tool: 2,
  canonical_diff_tool: 3,
  provider_tool: 4,
  provider_native: 5,
  inferred: 6,
};

const CONFIDENCE_PRECEDENCE: Record<ChangeConfidence, number> = {
  exact: 0,
  strong: 1,
  best_effort: 2,
};

const ATTRIBUTION_PRECEDENCE: Record<SessionAttributionConfidence, number> = {
  session_exact: 0,
  session_likely: 1,
  session_possible: 2,
  unknown: 3,
};

/** Tie-break at equal attribution confidence: keep the most informative reason. */
const ATTRIBUTION_REASON_PRECEDENCE: Record<SessionAttributionReason, number> = {
  provider_correlated: 0,
  canonical_tool_correlated: 1,
  checkpoint_overlap_observed: 2,
  checkpoint_no_happier_overlap_observed: 3,
  workspace_touched_path: 4,
  unavailable: 5,
};

const UNAVAILABLE_ATTRIBUTION: SessionChangeAttribution = {
  confidence: 'unknown',
  reason: 'unavailable',
};

export type ChangedFilesTurnEvidenceScope = 'all' | 'agent_reported' | 'checkpoint';

function sourceBelongsToTurnEvidenceScope(
  source: ChangeEvidenceSource,
  scope: ChangedFilesTurnEvidenceScope,
): boolean {
  if (scope === 'all') return true;
  if (scope === 'checkpoint') return source === 'scm_checkpoint';
  return source === 'provider_native'
    || source === 'provider_tool'
    || source === 'canonical_diff_tool'
    || source === 'canonical_patch_tool';
}

function pickMoreSpecificSource(left: ChangeEvidenceSource, right: ChangeEvidenceSource): ChangeEvidenceSource {
  return SOURCE_PRECEDENCE[left] <= SOURCE_PRECEDENCE[right] ? left : right;
}

function pickWeakerConfidence(left: ChangeConfidence, right: ChangeConfidence): ChangeConfidence {
  return CONFIDENCE_PRECEDENCE[left] >= CONFIDENCE_PRECEDENCE[right] ? left : right;
}

function compareNullableText(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? '').localeCompare(right ?? '');
}

function compareEvidence(left: FileChangeEvidence, right: FileChangeEvidence): number {
  return SOURCE_PRECEDENCE[left.source] - SOURCE_PRECEDENCE[right.source]
    || CONFIDENCE_PRECEDENCE[left.confidence] - CONFIDENCE_PRECEDENCE[right.confidence]
    || compareNullableText(left.provider, right.provider)
    || compareNullableText(left.agentTurnId, right.agentTurnId)
    || compareNullableText(left.providerMessageId, right.providerMessageId)
    || compareNullableText(left.previousFilePath, right.previousFilePath)
    || left.changeKind.localeCompare(right.changeKind)
    || compareNullableText(left.unifiedDiff, right.unifiedDiff)
    || compareNullableText(left.oldText, right.oldText)
    || compareNullableText(left.newText, right.newText)
    || Number(Boolean(left.binary)) - Number(Boolean(right.binary))
    || compareNullableText(left.description, right.description);
}

/**
 * Canonical turn order. Exported because "the latest turn" is a turn-identity question for every
 * host that presents a turn-scoped view: transcript arrival order is not it, since evidence for an
 * earlier turn can be published after a later turn's.
 */
export function compareTurnChangeSetChronology(left: TurnChangeSet, right: TurnChangeSet): number {
  return left.seqRange.startSeqInclusive - right.seqRange.startSeqInclusive
    || left.seqRange.endSeqInclusive - right.seqRange.endSeqInclusive
    || left.derivedAt - right.derivedAt
    || left.turnId.localeCompare(right.turnId);
}

/**
 * Attribution is the strongest correlation any contributing evidence establishes: weaker evidence
 * for the same file never dilutes a provider-correlated write, and it never upgrades a checkpoint
 * delta whose capture interval overlapped another writer.
 */
function pickMoreInformativeReason(
  left: SessionChangeAttribution,
  right: SessionChangeAttribution,
): SessionChangeAttribution {
  return ATTRIBUTION_REASON_PRECEDENCE[left.reason] <= ATTRIBUTION_REASON_PRECEDENCE[right.reason] ? left : right;
}

function pickStrongerAttribution(
  left: SessionChangeAttribution,
  right: SessionChangeAttribution,
): SessionChangeAttribution {
  if (left.confidence === right.confidence) return pickMoreInformativeReason(left, right);
  return ATTRIBUTION_PRECEDENCE[left.confidence] < ATTRIBUTION_PRECEDENCE[right.confidence] ? left : right;
}

function pickWeakerAttribution(
  left: SessionChangeAttribution,
  right: SessionChangeAttribution,
): SessionChangeAttribution {
  if (left.confidence === right.confidence) return pickMoreInformativeReason(left, right);
  return ATTRIBUTION_PRECEDENCE[left.confidence] > ATTRIBUTION_PRECEDENCE[right.confidence] ? left : right;
}

function readCheckpointOverlap(turn: TurnChangeSet): CheckpointOverlapObservation {
  const attributionScope = normalizeCheckpointAttributionScope(turn.repositoryCheckpoint?.attributionScope);
  if (attributionScope === 'shared_worktree') return 'observed';
  if (attributionScope === 'no_happier_checkpoint_overlap_observed') return 'not_observed';
  return 'unknown';
}

export function mergeCheckpointOverlap(
  left: CheckpointOverlapObservation,
  right: CheckpointOverlapObservation,
): CheckpointOverlapObservation {
  if (left === 'observed' || right === 'observed') return 'observed';
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return 'not_observed';
}

/**
 * Across turns, a contributing turn Happier never checkpointed is uncovered rather than neutral:
 * `not_observed` is a coverage claim and survives only when every contributing turn observed that
 * negative result. Corroborating evidence inside one checkpointed turn stays neutral.
 */
function foldCrossTurnCheckpointOverlap(
  left: CheckpointOverlapObservation | null,
  right: CheckpointOverlapObservation | null,
): CheckpointOverlapObservation | null {
  if (left === null && right === null) return null;
  return mergeCheckpointOverlap(left ?? 'unknown', right ?? 'unknown');
}

/**
 * Derives Session attribution from evidence that is already retained on the turn. Content certainty
 * and authorship certainty are independent: exact checkpoint bytes may coexist with `session_possible`
 * attribution, and no evidence class here can claim exclusive filesystem access.
 */
export function deriveSessionChangeAttribution(
  file: FileChangeEvidence,
  checkpointOverlap: CheckpointOverlapObservation,
): SessionChangeAttribution {
  return deriveSessionChangeAttributionFromSource(file.source, checkpointOverlap);
}

export function deriveSessionChangeAttributionFromSource(
  source: ChangeEvidenceSource,
  checkpointOverlap: CheckpointOverlapObservation,
): SessionChangeAttribution {
  switch (source) {
    case 'provider_native':
    case 'provider_tool':
      return { confidence: 'session_exact', reason: 'provider_correlated' };
    case 'canonical_diff_tool':
    case 'canonical_patch_tool':
      return { confidence: 'session_exact', reason: 'canonical_tool_correlated' };
    case 'scm_checkpoint':
      if (checkpointOverlap === 'observed') {
        return { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' };
      }
      if (checkpointOverlap === 'not_observed') {
        return { confidence: 'session_likely', reason: 'checkpoint_no_happier_overlap_observed' };
      }
      return UNAVAILABLE_ATTRIBUTION;
    case 'inferred':
      return { confidence: 'session_possible', reason: 'workspace_touched_path' };
    case 'scm_reconciled':
      return UNAVAILABLE_ATTRIBUTION;
  }
}

type SelectedTurnFile = Readonly<{
  file: SessionChangeSetFile;
  evidence: FileChangeEvidence[];
  attributionEvidence: FileChangeEvidence;
  checkpointEvidenceOverlap: CheckpointOverlapObservation | null;
}>;

function selectWithinTurnAttributionEvidence(
  left: FileChangeEvidence,
  right: FileChangeEvidence,
  checkpointOverlap: CheckpointOverlapObservation,
): FileChangeEvidence {
  const leftAttribution = deriveSessionChangeAttribution(left, left.source === 'scm_checkpoint' ? checkpointOverlap : 'unknown');
  const rightAttribution = deriveSessionChangeAttribution(right, right.source === 'scm_checkpoint' ? checkpointOverlap : 'unknown');
  if (leftAttribution.confidence !== rightAttribution.confidence) {
    return ATTRIBUTION_PRECEDENCE[leftAttribution.confidence] < ATTRIBUTION_PRECEDENCE[rightAttribution.confidence]
      ? left
      : right;
  }
  if (leftAttribution.reason !== rightAttribution.reason) {
    return ATTRIBUTION_REASON_PRECEDENCE[leftAttribution.reason] < ATTRIBUTION_REASON_PRECEDENCE[rightAttribution.reason]
      ? left
      : right;
  }
  return compareEvidence(left, right) <= 0 ? left : right;
}

function mergeFileEvidence(
  current: SelectedTurnFile | null,
  next: FileChangeEvidence,
  turnId: string,
  turnCheckpointOverlap: CheckpointOverlapObservation,
  originalEvidence: FileChangeEvidence,
): SelectedTurnFile {
  const nextCheckpointOverlap = next.source === 'scm_checkpoint' ? turnCheckpointOverlap : 'unknown';
  const nextAttribution = deriveSessionChangeAttribution(next, nextCheckpointOverlap);

  if (!current) {
    return {
      file: {
        ...next,
        turns: [turnId],
        attribution: nextAttribution,
        checkpointOverlap: nextCheckpointOverlap,
      },
      attributionEvidence: next,
      evidence: [originalEvidence],
      checkpointEvidenceOverlap: next.source === 'scm_checkpoint' ? turnCheckpointOverlap : null,
    };
  }

  // Within one turn the canonical content source wins independently of evidence ordering.
  const content = compareEvidence(current.file, next) <= 0 ? current.file : next;
  const attributionEvidence = selectWithinTurnAttributionEvidence(
    current.attributionEvidence,
    next,
    turnCheckpointOverlap,
  );
  const attribution = pickStrongerAttribution(current.file.attribution, nextAttribution);
  const checkpointEvidenceOverlap = next.source !== 'scm_checkpoint'
    ? current.checkpointEvidenceOverlap
    : current.checkpointEvidenceOverlap === null
      ? turnCheckpointOverlap
      : mergeCheckpointOverlap(current.checkpointEvidenceOverlap, turnCheckpointOverlap);

  current.evidence.push(originalEvidence);
  return {
    file: {
      ...content,
      provider: attributionEvidence.provider,
      agentTurnId: attributionEvidence.agentTurnId ?? null,
      providerMessageId: attributionEvidence.providerMessageId ?? null,
      attribution,
      checkpointOverlap: checkpointEvidenceOverlap ?? 'unknown',
      turns: current.file.turns.includes(turnId) ? current.file.turns : [...current.file.turns, turnId],
    },
    attributionEvidence,
    evidence: current.evidence,
    checkpointEvidenceOverlap,
  };
}

function pickChronologicalAttributionOwner(
  previous: SessionChangeSetFile,
  next: SessionChangeSetFile,
): SessionChangeSetFile {
  if (previous.attribution.confidence !== next.attribution.confidence) {
    return ATTRIBUTION_PRECEDENCE[previous.attribution.confidence] > ATTRIBUTION_PRECEDENCE[next.attribution.confidence]
      ? previous
      : next;
  }
  if (previous.attribution.reason !== next.attribution.reason) {
    return ATTRIBUTION_REASON_PRECEDENCE[previous.attribution.reason] <= ATTRIBUTION_REASON_PRECEDENCE[next.attribution.reason]
      ? previous
      : next;
  }
  return compareEvidence(previous, next) <= 0 ? previous : next;
}

function orderTurnFilesForRenameLineage(files: Iterable<SelectedTurnFile>): SelectedTurnFile[] {
  const entries = [...files].sort((left, right) => left.file.filePath.localeCompare(right.file.filePath));
  const byPath = new Map(entries.map((entry) => [entry.file.filePath, entry] as const));
  const indegree = new Map<string, number>(entries.map((entry) => [entry.file.filePath, 0] as const));
  const dependents = new Map<string, string[]>();

  for (const entry of entries) {
    const previousPath = entry.file.changeKind === 'renamed'
      ? entry.file.previousFilePath
      : null;
    if (!previousPath || previousPath === entry.file.filePath || !byPath.has(previousPath)) continue;
    indegree.set(entry.file.filePath, 1);
    const existing = dependents.get(previousPath);
    if (existing) existing.push(entry.file.filePath);
    else dependents.set(previousPath, [entry.file.filePath]);
  }

  // A tiny string min-heap preserves the former smallest-ready-path ordering
  // without repeatedly scanning and splicing the whole pending array.
  const ready: string[] = [];
  const pushReady = (path: string) => {
    let index = ready.push(path) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (ready[parent]!.localeCompare(ready[index]!) <= 0) break;
      [ready[parent], ready[index]] = [ready[index]!, ready[parent]!];
      index = parent;
    }
  };
  const popReady = (): string | null => {
    const first = ready[0];
    if (first === undefined) return null;
    const last = ready.pop()!;
    if (ready.length === 0) return first;
    ready[0] = last;
    let index = 0;
    while (true) {
      const left = (index * 2) + 1;
      const right = left + 1;
      let smallest = index;
      if (left < ready.length && ready[left]!.localeCompare(ready[smallest]!) < 0) smallest = left;
      if (right < ready.length && ready[right]!.localeCompare(ready[smallest]!) < 0) smallest = right;
      if (smallest === index) break;
      [ready[index], ready[smallest]] = [ready[smallest]!, ready[index]!];
      index = smallest;
    }
    return first;
  };

  for (const entry of entries) {
    if (indegree.get(entry.file.filePath) === 0) pushReady(entry.file.filePath);
  }

  const ordered: SelectedTurnFile[] = [];
  const emitted = new Set<string>();
  for (let path = popReady(); path !== null; path = popReady()) {
    const entry = byPath.get(path);
    if (!entry) continue;
    ordered.push(entry);
    emitted.add(path);
    for (const dependentPath of dependents.get(path) ?? []) {
      const nextIndegree = (indegree.get(dependentPath) ?? 0) - 1;
      indegree.set(dependentPath, nextIndegree);
      if (nextIndegree === 0) pushReady(dependentPath);
    }
  }

  // A malformed/cyclic rename set has no trustworthy lineage. Stable path
  // order keeps its independent entries deterministic without inventing one.
  ordered.push(...entries.filter((entry) => !emitted.has(entry.file.filePath)));
  return ordered;
}

type MergeTurnChangeSetsInput = Readonly<{
  sessionId: string;
  turns: readonly TurnChangeSet[];
  rolledBackTurnIds?: readonly string[];
  repoRootPath?: string | null;
}>;

/** Derived only; retained turns remain the serialized evidence owner. */
export type ChangedFilesAttributionProjection = Readonly<{
  changeSet: SessionChangeSet;
  evidenceByFilePath: ReadonlyMap<string, readonly FileChangeEvidence[]>;
}>;

function projectTurnChangeSets(params: MergeTurnChangeSetsInput): ChangedFilesAttributionProjection {
  const byFilePath = new Map<string, SelectedTurnFile>();
  let summarySource: ChangeEvidenceSource | 'unavailable' = 'unavailable';
  let summaryConfidence: ChangeConfidence | 'unavailable' = 'unavailable';
  const chronologicalTurns = [...params.turns].sort(compareTurnChangeSetChronology);

  for (const turn of chronologicalTurns) {
    const turnCheckpointOverlap = readCheckpointOverlap(turn);
    // Resolve competing observations of one turn before composing chronological turns.
    // Otherwise an older checkpoint can mislabel later bytes or replace the Session's start text.
    const turnFiles = new Map<string, SelectedTurnFile>();
    for (const evidence of turn.files) {
      const file = normalizeFileEvidencePaths(evidence, params.repoRootPath);
      turnFiles.set(file.filePath, mergeFileEvidence(turnFiles.get(file.filePath) ?? null, file, turn.turnId, turnCheckpointOverlap, evidence));
    }
    for (const selected of orderTurnFilesForRenameLineage(turnFiles.values())) {
      const file = selected.file;
      const renameSourcePath = file.changeKind === 'renamed' ? file.previousFilePath : null;
      const previousKey = renameSourcePath && byFilePath.has(renameSourcePath)
        ? renameSourcePath
        : file.filePath;
      const previous = byFilePath.get(previousKey);
      if (!previous) {
        byFilePath.set(file.filePath, selected);
        continue;
      }
      if (previousKey !== file.filePath) byFilePath.delete(previousKey);
      const attributionOwner = pickChronologicalAttributionOwner(previous.file, file);
      const checkpointEvidenceOverlap = foldCrossTurnCheckpointOverlap(
        previous.checkpointEvidenceOverlap,
        selected.checkpointEvidenceOverlap,
      );
      // These endpoints may be Edit fragments, not full files. A connecting nonempty comparison is
      // useful best-effort span evidence; equality cannot prove the whole file reverted or is clean.
      const hasNetText = !previous.file.binary && !file.binary
        && !previous.file.truncated && !file.truncated
        && typeof previous.file.oldText === 'string' && typeof previous.file.newText === 'string'
        && typeof file.oldText === 'string' && typeof file.newText === 'string'
        && previous.file.newText === file.oldText
        && previous.file.oldText !== file.newText;
      for (const evidence of selected.evidence) previous.evidence.push(evidence);
      byFilePath.set(file.filePath, {
        file: {
          ...file,
          previousFilePath: previous.file.previousFilePath ?? file.previousFilePath ?? null,
          oldText: hasNetText ? previous.file.oldText : null,
          newText: hasNetText ? file.newText : null,
          unifiedDiff: null,
          stats: undefined,
          confidence: 'best_effort',
          provider: attributionOwner.provider,
          agentTurnId: attributionOwner.agentTurnId ?? null,
          providerMessageId: attributionOwner.providerMessageId ?? null,
          attribution: pickWeakerAttribution(previous.file.attribution, file.attribution),
          checkpointOverlap: checkpointEvidenceOverlap ?? 'unknown',
          turns: previous.file.turns.includes(turn.turnId)
            ? previous.file.turns
            : [...previous.file.turns, turn.turnId],
        },
        attributionEvidence: selected.attributionEvidence,
        evidence: previous.evidence,
        checkpointEvidenceOverlap,
      });
    }
  }

  const aggregatedFiles = Array.from(byFilePath.values())
    .sort((left, right) => left.file.filePath.localeCompare(right.file.filePath));
  const files = aggregatedFiles.map((entry) => entry.file);

  let summaryAttribution: SessionChangeAttribution | null = null;
  let summaryCheckpointOverlap: CheckpointOverlapObservation | null = null;

  for (const entry of aggregatedFiles) {
    const file = entry.file;
    summarySource = summarySource === 'unavailable'
      ? file.source
      : pickMoreSpecificSource(summarySource, file.source);
    summaryConfidence = summaryConfidence === 'unavailable'
      ? file.confidence
      : pickWeakerConfidence(summaryConfidence, file.confidence);
    summaryAttribution = summaryAttribution
      ? pickWeakerAttribution(summaryAttribution, file.attribution)
      : file.attribution;
    if (entry.checkpointEvidenceOverlap !== null) {
      summaryCheckpointOverlap = summaryCheckpointOverlap === null
        ? entry.checkpointEvidenceOverlap
        : mergeCheckpointOverlap(summaryCheckpointOverlap, entry.checkpointEvidenceOverlap);
    }
  }

  const changeSet: SessionChangeSet = {
    sessionId: params.sessionId,
    turns: chronologicalTurns,
    files,
    rolledBackTurnIds: [...(params.rolledBackTurnIds ?? [])],
    confidenceSummary: {
      source: summarySource,
      confidence: summaryConfidence,
      attribution: summaryAttribution ?? UNAVAILABLE_ATTRIBUTION,
      checkpointOverlap: summaryCheckpointOverlap ?? 'unknown',
    },
  };
  return {
    changeSet,
    evidenceByFilePath: new Map(aggregatedFiles.map((entry) => [entry.file.filePath, entry.evidence])),
  };
}

export function mergeTurnChangeSets(params: MergeTurnChangeSetsInput): SessionChangeSet {
  return projectTurnChangeSets(params).changeSet;
}

/**
 * Canonical Changed Files attribution entry point. Provider/tool/checkpoint observations are
 * resolved by the turn combiner first. Turn-source scope classification also stays here so mounted
 * hosts select a presentation without duplicating evidence categories. Turn-end checkpoint
 * evidence is the daemon-owned record of a Session's changes; no host infers authorship from
 * repository snapshots.
 */
type ChangedFilesAttributionInput = Readonly<{
  sessionId: string;
  turns?: readonly TurnChangeSet[];
  evidenceScope?: ChangedFilesTurnEvidenceScope;
  canonicalChangeSet?: SessionChangeSet | null;
  rolledBackTurnIds?: readonly string[];
  repoRootPath?: string | null;
}>;

export function combineChangedFilesAttribution(params: ChangedFilesAttributionInput): SessionChangeSet {
  return projectChangedFilesAttribution(params).changeSet;
}

function normalizeFileEvidencePaths<T extends FileChangeEvidence>(file: T, repoRootPath?: string | null): T {
  return {
    ...file,
    filePath: normalizeRepositoryFilePath(file.filePath, repoRootPath),
    ...(file.previousFilePath ? {
      previousFilePath: normalizeRepositoryFilePath(file.previousFilePath, repoRootPath),
    } : {}),
  };
}

export function projectChangedFilesAttribution(params: ChangedFilesAttributionInput): ChangedFilesAttributionProjection {
  const evidenceScope = params.evidenceScope ?? 'all';
  const rawTurns = (params.turns ?? []).map((turn) => ({
    ...turn,
    files: turn.files.filter((file) => sourceBelongsToTurnEvidenceScope(file.source, evidenceScope)),
  }));
  if (rawTurns.length > 0) {
    const merged = projectTurnChangeSets({
      sessionId: params.sessionId,
      turns: rawTurns,
      rolledBackTurnIds: params.rolledBackTurnIds,
      repoRootPath: params.repoRootPath,
    });
    if (merged.changeSet.files.length > 0 || evidenceScope !== 'all') return merged;
  }

  if (params.canonicalChangeSet && params.canonicalChangeSet.files.length > 0) {
    if (params.canonicalChangeSet.turns.length > 0) {
      return projectTurnChangeSets({
          sessionId: params.sessionId,
          turns: params.canonicalChangeSet.turns,
          rolledBackTurnIds: params.canonicalChangeSet.rolledBackTurnIds,
          repoRootPath: params.repoRootPath,
        });
    }
    const files = params.canonicalChangeSet.files.map((file) => normalizeFileEvidencePaths(file, params.repoRootPath));
    return {
      changeSet: { ...params.canonicalChangeSet, files },
      evidenceByFilePath: new Map(files.map((file, index) => [file.filePath, [params.canonicalChangeSet!.files[index]!]])),
    };
  }

  return projectTurnChangeSets({
    sessionId: params.sessionId,
    turns: [],
    rolledBackTurnIds: params.rolledBackTurnIds,
  });
}

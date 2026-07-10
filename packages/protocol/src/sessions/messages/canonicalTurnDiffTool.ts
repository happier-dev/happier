import type {
  ChangeConfidence,
  ChangeEvidenceSource,
  FileChangeEvidence,
  FileChangeKind,
  RepositoryCheckpointTurnMetadata,
} from '../changes/schemas.js';
import { RepositoryCheckpointTurnMetadataSchema } from '../changes/schemas.js';

type RecordLike = Record<string, unknown>;

const FILE_CHANGE_KINDS = new Set<FileChangeKind>(['added', 'modified', 'deleted', 'renamed', 'copied', 'unknown']);
const CHANGE_SOURCES = new Set<ChangeEvidenceSource>([
  'provider_native',
  'provider_tool',
  'canonical_diff_tool',
  'canonical_patch_tool',
  'scm_checkpoint',
  'scm_reconciled',
  'inferred',
]);
const CHANGE_CONFIDENCES = new Set<ChangeConfidence>(['exact', 'strong', 'best_effort']);

function asRecord(value: unknown): RecordLike | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as RecordLike
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringField(record: RecordLike | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

export type TurnChangeToolMetadata = Readonly<{
  turnId: string;
  sessionId: string;
  provider: string;
  source: ChangeEvidenceSource;
  confidence: ChangeConfidence;
  turnStatus: 'completed' | 'aborted' | 'interrupted' | 'unknown';
  seqRange: {
    startSeqInclusive: number;
    endSeqInclusive: number;
  };
  repositoryCheckpoint?: RepositoryCheckpointTurnMetadata;
}>;

export function readTurnChangeToolMetadata(input: unknown): TurnChangeToolMetadata | null {
  const record = asRecord(input);
  if (!record) return null;

  const meta = asRecord(record._happier) ?? asRecord(record._happy);
  if (meta) {
    if (meta.sessionChangeScope !== 'turn') return null;
    const turnId = readNonEmptyString(meta.turnId);
    const sessionId = readNonEmptyString(meta.sessionId);
    const provider = readNonEmptyString(meta.provider);
    const source = readNonEmptyString(meta.source);
    const confidence = readNonEmptyString(meta.confidence);
    const seqRange = asRecord(meta.seqRange);
    const startSeqInclusive = typeof seqRange?.startSeqInclusive === 'number' ? seqRange.startSeqInclusive : null;
    const endSeqInclusive = typeof seqRange?.endSeqInclusive === 'number' ? seqRange.endSeqInclusive : null;
    if (!turnId || !sessionId || !provider || !source || !confidence) return null;
    if (!CHANGE_SOURCES.has(source as ChangeEvidenceSource)) return null;
    if (!CHANGE_CONFIDENCES.has(confidence as ChangeConfidence)) return null;
    if (startSeqInclusive == null || endSeqInclusive == null) return null;
    const repositoryCheckpoint = RepositoryCheckpointTurnMetadataSchema.safeParse(meta.repositoryCheckpoint);
    const turnStatus = readNonEmptyString(meta.turnStatus);
    return {
      turnId,
      sessionId,
      provider,
      source: source as ChangeEvidenceSource,
      confidence: confidence as ChangeConfidence,
      turnStatus: turnStatus === 'aborted' || turnStatus === 'interrupted' || turnStatus === 'unknown'
        ? turnStatus
        : 'completed',
      seqRange: {
        startSeqInclusive,
        endSeqInclusive,
      },
      ...(repositoryCheckpoint.success ? { repositoryCheckpoint: repositoryCheckpoint.data } : {}),
    };
  }

  for (const key of ['output', 'input', 'payload', 'data', 'result', 'value', 'content'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const nested = readTurnChangeToolMetadata(record[key]);
    if (nested) return nested;
  }

  const toolUseResult = record.tool_use_result;
  if (typeof toolUseResult === 'string') {
    const nested = readTurnChangeToolMetadata(toolUseResult);
    if (nested) return nested;
  }

  return null;
}

export function readTurnChangeToolMetadataFromToolCall(tool: Readonly<{
  input?: unknown;
  result?: unknown;
}>): TurnChangeToolMetadata | null {
  return readTurnChangeToolMetadata(tool.input) ?? readTurnChangeToolMetadata(tool.result);
}

export function extractCanonicalDiffFiles(input: unknown, metadata: TurnChangeToolMetadata): FileChangeEvidence[] {
  const record = asRecord(input);
  const rawFiles = Array.isArray(record?.files) ? record.files : [];
  return rawFiles
    .map((file) => asRecord(file))
    .filter((file): file is RecordLike => Boolean(file))
    .flatMap((file) => {
      const filePath = readStringField(file, ['file_path', 'filePath', 'path']) ?? '';
      if (!filePath) return [];
      const changeKind = readStringField(file, ['change_kind', 'changeKind']);
      const source = readStringField(file, ['source']);
      const confidence = readStringField(file, ['confidence']);
      const provider = readStringField(file, ['provider']);
      const previousFilePath = readStringField(file, ['previous_file_path', 'previousFilePath']);
      return [{
        filePath,
        ...(previousFilePath ? { previousFilePath } : {}),
        changeKind: changeKind && FILE_CHANGE_KINDS.has(changeKind as FileChangeKind)
          ? changeKind as FileChangeKind
          : 'modified',
        unifiedDiff: typeof file.unified_diff === 'string' ? file.unified_diff : undefined,
        oldText: typeof file.oldText === 'string' ? file.oldText : typeof file.old_text === 'string' ? file.old_text : undefined,
        newText: typeof file.newText === 'string' ? file.newText : typeof file.new_text === 'string' ? file.new_text : undefined,
        ...(typeof file.binary === 'boolean' ? { binary: file.binary } : {}),
        source: source && CHANGE_SOURCES.has(source as ChangeEvidenceSource)
          ? source as ChangeEvidenceSource
          : metadata.source,
        confidence: confidence && CHANGE_CONFIDENCES.has(confidence as ChangeConfidence)
          ? confidence as ChangeConfidence
          : metadata.confidence,
        provider: provider ?? metadata.provider,
        agentTurnId: metadata.turnId,
      }];
    });
}

function readCanonicalToolName(value: unknown): string | null {
  const record = asRecord(value);
  const meta = asRecord(record?._happier) ?? asRecord(record?._happy);
  return readNonEmptyString(meta?.canonicalToolName);
}

function hasCanonicalDiffEvidenceForMetadata(input: unknown, metadata: TurnChangeToolMetadata): boolean {
  const record = asRecord(input);
  const evidenceInput = record ?? input;

  if (extractCanonicalDiffFiles(evidenceInput, metadata).length > 0) return true;

  if (!record) return false;

  return readStringField(record, ['unified_diff', 'unifiedDiff', 'diff']) !== null;
}

function hasUnmarkedCanonicalDiffEvidence(input: unknown, depth = 0): boolean {
  const record = asRecord(input);
  if (!record) return false;
  if (readStringField(record, ['unified_diff', 'unifiedDiff', 'diff']) !== null) return true;

  const files = Array.isArray(record.files) ? record.files : [];
  if (files.some((file) => {
    const fileRecord = asRecord(file);
    if (!fileRecord) return false;
    return readStringField(fileRecord, ['file_path', 'filePath', 'path']) !== null;
  })) {
    return true;
  }

  if (depth >= 2) return false;
  return ['_raw', '_acp', 'input', 'output', 'result', 'data'].some((key) => (
    record[key] !== undefined && hasUnmarkedCanonicalDiffEvidence(record[key], depth + 1)
  ));
}

export function isCanonicalTurnDiffPayload(input: unknown): boolean {
  return readTurnChangeToolMetadata(input) !== null || readCanonicalToolName(input) === 'Diff';
}

function hasCanonicalDiffEvidence(input: unknown): boolean {
  const metadata = readTurnChangeToolMetadata(input);
  if (!metadata) return hasUnmarkedCanonicalDiffEvidence(input);
  return hasCanonicalDiffEvidenceForMetadata(input, metadata);
}

export function hasCanonicalTurnDiffEvidence(input: unknown): boolean {
  return hasCanonicalDiffEvidence(input);
}

export function shouldSuppressEmptyCanonicalTurnDiffToolCall(params: Readonly<{
  toolName: unknown;
  input: unknown;
}>): boolean {
  if (params.toolName !== 'Diff') return false;
  if (!isCanonicalTurnDiffPayload(params.input)) return false;
  return !hasCanonicalDiffEvidence(params.input);
}

export function readEmptyCanonicalTurnDiffToolCallId(rawInput: unknown): string | null {
  const raw = asRecord(rawInput);
  const content = asRecord(raw?.content);
  if (!content) return null;
  const contentType = content.type;
  if (contentType !== 'codex' && contentType !== 'acp') return null;

  const data = asRecord(content.data);
  if (!data || data.type !== 'tool-call') return null;

  const callId = readStringField(data, ['callId', 'call_id']);
  if (!callId) return null;

  const toolName = readStringField(data, ['name', 'toolName']);
  return shouldSuppressEmptyCanonicalTurnDiffToolCall({
    toolName,
    input: data.input,
  })
    ? callId
    : null;
}
